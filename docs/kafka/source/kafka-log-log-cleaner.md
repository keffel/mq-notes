---
title: 日志清理
date: 2018-06-28
state: inprogress
---

## 日志清理策略

Kafka的日志文件不会永久保存，当日志超出保留窗口的时候，会对日志进行清理，清理分为两类，压缩和删除：

    // kafka.server.KafkaConfig
    new ConfigDef().define(
        name          = "log.cleanup.policy", 
        type          = LIST, 
        defaultValue  = "delete", 
        validator     = ValidList.in("compact", "delete")
        importance    = MEDIUM, 
        documentation = "...")

从这段配置定义可以看出来，清理策略由配置`log.cleanup.policy`决定，取值是由`compact`、`delete`组成的列表：

* Log Compact - 日志压缩，用于合并相同Key的数据，只保留最新的value；
* Log Delete - 日志删除，用于清理很老的，或者超出文件大小限制的LogSegment。

另外还有一个和topic关联的`cleanup.policy`配置，可以覆盖全局的策略。

## CleanerConfig

日志清理的相关配置保存在`kafka.log.CleanerConfig`。

    // config: KafkaConfig
    val cleanerConfig = LogCleaner.cleanerConfig(config)
    ...
    def cleanerConfig(config: KafkaConfig): CleanerConfig = {
        CleanerConfig(
            numThreads =              // log.cleaner.threads            (int)     default 1
            dedupeBufferSize =        // log.cleaner.dedupe.buffer.size (long)    default 128M
            dedupeBufferLoadFactor =  // log.cleaner.io.buffer.load.factor (double) default 0.9
            ioBufferSize =            // log.cleaner.io.buffer.size     (int)     default 512K
            maxMessageSize =          // message.max.bytes              (int)     default 1000012
            maxIoBytesPerSecond       // log.cleaner.io.max.bytes.per.second (double) default Double.MAX
            backOffMs =               // log.cleaner.backoff.ms         (long)    default 15 seconds
            enableCleaner             // log.cleaner.enable             (boolean) default true
    }

其中：

* `log.cleaner.dedupe.buffer.size` - 用于日志去重的内存大小，所有清理线程共享；
* `log.cleaner.io.buffer.load.factor` - 去重负载因子
* `log.cleaner.io.buffer.size` - 做IO缓存的内存大小，所有清理线程共享；
* `message.max.bytes` - 最后的12是消息头部大小
* `log.cleaner.backoff.ms` - 没有日志要清理情况下的休眠时间

## LogCleaner日志压缩

负责日志压缩的是`kafka.log.LogCleaner`，在本文开头展示的配置代码里面可以看到，压缩默认是关闭的，需要在`log.cleanup.policy`配置里面增加`compact`来开启。

LogCleaner的入口在LogManager里：

    val cleaner: LogCleaner =
        if(cleanerConfig.enableCleaner)
            new LogCleaner(cleanerConfig, liveLogDirs, currentLogs, logDirFailureChannel, time = time)
        else
            null
    ...
    if (cleanerConfig.enableCleaner)
        cleaner.startup()

先来介绍`LogCleaner`的构造和`startup`：

    class LogCleaner(initialConfig: CleanerConfig,
                     val logDirs: Seq[File],
                     val logs: Pool[TopicPartition, Log],
                     val logDirFailureChannel: LogDirFailureChannel,
                     ...) extends BrokerReconfigurable with ... {

        @volatile private var config = initialConfig
        private[log] val cleanerManager = new LogCleanerManager(logDirs, logs, logDirFailureChannel)
        private val cleaners = mutable.ArrayBuffer[CleanerThread]()

        def startup() {
            (0 until config.numThreads).foreach { i =>
                // CleanerThread的线程名是 kafka-log-cleaner-thread-${i}
                val cleaner = new CleanerThread(i)
                cleaners += cleaner
                cleaner.start()
            }
        }

        /* 实现了BrokerReconfigurable接口，会对config做动态更新 */
        override def reconfigure(oldConfig: KafkaConfig, newConfig: KafkaConfig): Unit = {
            config = LogCleaner.cleanerConfig(newConfig)
            shutdown()
            startup()
        }
        ...
    }

可以看到`startup`就是启动了多个Cleaner线程。`config.numThreads`取值于`log.cleaner.threads`，详见本文第一部分。

### CleanerThread

`CleanerThread`是一个`ShutdownableThread`：

    private class CleanerThread(threadId: Int) extends ShutdownableThread(name = "kafka-log-cleaner-thread-" + threadId, isInterruptible = false) {
        ...
        override def doWork() {
            cleanOrSleep()
        }
    }

这个类的`work`方法会被循环调用，具体操作定义在`cleanOrSleep`：

    private def cleanOrSleep() {
        val cleaned = cleanerManager.grabFilthiestCompactedLog(time) match {
            case None => false
            case Some(cleanable) =>
                var endOffset = cleanable.firstDirtyOffset
                try {
                    // 关键在这里的clean方法
                    val (nextDirtyOffset, cleanerStats) = cleaner.clean(cleanable)
                    recordStats(cleaner.id, cleanable.xxx, endOffset, cleanerStats)
                    endOffset = nextDirtyOffset
                } catch {
                    case _: LogCleaningAbortedException => // 忽略task被打断的异常
                    case _: KafkaStorageException => // 忽略partition下线的异常
                    case e: IOException =>
                        val msg = ...
                        logDirFailureChannel.maybeAddOfflineLogDir(cleanable.log.dir.getParent, msg, e)
                } finally {
                    cleanerManager.doneCleaning(cleanable.topicPartition, cleanable.log.dir.getParentFile, endOffset)
                }
                true
        }
        val deletable: Iterable[(TopicPartition, Log)] = cleanerManager.deletableLogs()
        deletable.foreach { case (topicPartition, log) =>
            try {
                log.deleteOldSegments()
            } finally {
                cleanerManager.doneDeleting(topicPartition)
            }
        }
        if (!cleaned)
            pause(config.backOffMs, TimeUnit.MILLISECONDS)
    }

首先通过[LogCleanerManager.grabFilthiestCompactedLog](kafka-log-log-cleaner-manager.html#计算最应该压缩的日志)来获取最需要压缩的文件，每次执行Compact的时候，出于性能考虑，并不会把所有老文件都进行压缩，而是选取最需要压缩的日志文件，简单来说kafka通过选取要压缩的字节数占所有“老数据”的比例最大的进行压缩。

这之后，被选中的日志文件会被交给内部类`Cleaner`的`clean`方法来进行真实的压缩操作，最终返回已经清理到的offset位置和统计信息，首先来计算一个叫做`deleteHorizonMs`的安全标识，`cleanable.firstDirtyOffset`是这次要压缩的起始offset，`0`到`cleanable.firstDirtyOffset`之间的是再上一轮完成压缩的数据，这里面只保留和最后一条数据时间差小于`delete.retention.ms`配置值得，更老的压缩文件可以删除掉：

    private[log] def clean(cleanable: LogToClean): (Long, CleanerStats) = {
        val deleteHorizonMs =
            cleanable.log.logSegments(0, cleanable.firstDirtyOffset).lastOption match {
                case None => 0L
                case Some(seg) => seg.lastModified - cleanable.log.config.deleteRetentionMs
            }
        doClean(cleanable, deleteHorizonMs)
    }

然后是压缩的详细过程：

    private[log] def doClean(cleanable: LogToClean, deleteHorizonMs: Long): (Long, CleanerStats) = {
        val log = cleanable.log
        val stats = new CleanerStats()  // 相关统计代码都忽略了

        // 1. 构建OffsetMap，里面保存单个Segment里所有key和最后offset的映射，后面会详细介绍
        val upperBoundOffset = cleanable.firstUncleanableOffset
        buildOffsetMap(log, cleanable.firstDirtyOffset, upperBoundOffset, offsetMap, stats)
        val endOffset = offsetMap.latestOffset + 1

        // 2. 计算待压缩日志文件的最大最后修改时间
        val cleanableHorizonMs = log.logSegments(0, cleanable.firstUncleanableOffset).lastOption.map(_.lastModified).getOrElse(0L)

        // 3. 把segments分组压缩
        for (group <- groupSegmentsBySize(log.logSegments(0, endOffset), log.config.segmentSize, log.config.maxIndexSize, cleanable.firstUncleanableOffset))
            cleanSegments(log, group, offsetMap, deleteHorizonMs, stats)

        (endOffset, stats)
    }

TODO 补一个说明各个offset点相对位置的图

其中offsetMap是在构造`Cleaner`时传入的新建对象：

    offsetMap = new SkimpyOffsetMap(
        memory = math.min(config.dedupeBufferSize / config.numThreads, Int.MaxValue).toInt, 
        hashAlgorithm = config.hashAlgorithm)

[SkimpyOffsetMap](kafka-log-offset-map)可以看做是`HashMap[byte[], Long]`，记录Key到offset的映射，参数是占用的内存总大小和哈希算法。

`groupSegmentsBySize`的分组策略比较简单，就是对segments列表按照下面的规则把连续segment分到一组：

* 日志文件字节数总和小于配置`segment.bytes`的值；
* offsetIndex的字节数总和小于配置`segment.index.bytes`的值；
* timeIndex的字节数总和小于配置`segment.index.bytes`的值；
* 最后一个segment对应的最大offset和第一个segment的最小offset差值在Integer范围内。

TODO 补一个说明groupSegmentsBySize的图。

下面介绍压缩的详细过程，这个方法的目标是把分好组的segments压缩进一个`.cleaned`后缀的临时文件（一共四个，分别是`log.cleaned` / `offsetIndex.cleaned` / `timeIndex.cleaned` / `txnIndex.cleaned`），所以首先删掉之前未完成的临时文件，然后遍历所有segments，调用`cleanInto`把数据写入`.cleaned`（代码中的`cleaned`也是一个segment，包含全部的四个文件）里面：

    // 源代码中最后还有一个 CleanerStats 参数，此处省略，具体参照源码
    private[log] def cleanSegments(log: Log,
                                   segments: Seq[LogSegment],
                                   map: OffsetMap,
                                   deleteHorizonMs: Long) {
        val firstSegment = segments.head
        // 尝试删除已经存在的 *.cleaned 文件，然后创建新的 .cleaned
        deleteCleanedFileIfExists(log.xxx.file)

        val baseOffset = firstSegment.baseOffset
        val cleaned = LogSegment.open(log.dir, baseOffset, log.config, time, fileSuffix = Log.CleanedFileSuffix, initFileSize = log.initFileSize, preallocate = log.config.preallocate)

        try {
            // clean segments into the new destination segment
            val iter = segments.iterator
            var currentSegmentOpt: Option[LogSegment] = Some(iter.next())
            while (currentSegmentOpt.isDefined) {
                val currentSegment = currentSegmentOpt.get
                val nextSegmentOpt = if (iter.hasNext) Some(iter.next()) else None

                val startOffset = currentSegment.baseOffset
                val upperBoundOffset = nextSegmentOpt.map(_.baseOffset).getOrElse(map.latestOffset + 1)
                val abortedTransactions = log.collectAbortedTransactions(startOffset, upperBoundOffset)
                val transactionMetadata = CleanedTransactionMetadata(abortedTransactions, Some(cleaned.txnIndex))

                // true表示这个文件还可以保留，false就直接干掉了
                val retainDeletes = currentSegment.lastModified > deleteHorizonMs
                cleanInto(log.topicPartition, currentSegment.log, cleaned, map, retainDeletes, log.config.maxMessageSize, transactionMetadata, log.activeProducersWithLastSequence)

                currentSegmentOpt = nextSegmentOpt
            }

            cleaned.onBecomeInactiveSegment()
            cleaned.flush()  // swap之前写入磁盘

            // 更新lastModified，会影响下次压缩时deleteHorizonMs的计算
            val modified = segments.last.lastModified
            cleaned.lastModified = modified

            // replace之后变成正式的segment文件
            log.replaceSegments(cleaned, segments)
        } catch {
            case e: LogCleaningAbortedException => cleaned.deleteIfExists(); throw e;
        }
    }

下面是最最核心的`cleanInto`方法，这是把每个segment合并到cleaned的逻辑：

    // 源代码中最后还有一个 stats: CleanerStats 参数，此处省略，具体参照源码
    private[log] def cleanInto(topicPartition: TopicPartition,
                               sourceRecords: FileRecords,
                               dest: LogSegment,
                               map: OffsetMap,
                               retainDeletes: Boolean,
                               maxLogMessageSize: Int,
                               transactionMetadata: CleanedTransactionMetadata,
                               activeProducers: Map[Long, Int]) {
        val logCleanerFilter = new RecordFilter {
            var discardBatchRecords: Boolean = _
            // 判断是不是整个batch都能删
            override def checkBatchRetention(batch: RecordBatch): BatchRetention = {...}
            // 检查单条记录是不是要留着
            override def shouldRetainRecord(batch: RecordBatch, record: Record): Boolean = {...}
        }

        var position = 0
        while (position < sourceRecords.sizeInBytes) {
            checkDone(topicPartition)  // 内部调用 cleanerManager.checkCleaningAborted(topicPartition) 做检查
            // 读数据到readBuffer，然后把要保留的写入writeBuffer
            readBuffer.clear()
            writeBuffer.clear()

            sourceRecords.readInto(readBuffer, position)  // 写满buffer，最后一条可能不是完整消息
            val records = MemoryRecords.readableRecords(readBuffer)  // 读出所有完整的消息
            throttler.maybeThrottle(records.sizeInBytes)
            val result = records.filterTo(topicPartition, logCleanerFilter, writeBuffer, maxLogMessageSize, decompressionBufferSupplier)

            position += result.bytesRead

            val outputBuffer = result.output
            if (outputBuffer.position() > 0) {
                outputBuffer.flip()
                val retained = MemoryRecords.readableRecords(outputBuffer)
                // dest在这里不需要加锁，replaceSegments（需要锁）之后才会被其他线程访问
                dest.append(firstOffset = retained.batches.iterator.next().baseOffset,
                    largestOffset = result.maxOffset,
                    largestTimestamp = result.maxTimestamp,
                    shallowOffsetOfMaxTimestamp = result.shallowOffsetOfMaxTimestamp,
                    records = retained)
                throttler.maybeThrottle(outputBuffer.limit())
            }

            // 读到数据了但是buffer太小容不下一条消息，扩大buffer后重试
            if (readBuffer.limit() > 0 && result.messagesRead == 0)
                growBuffers(maxLogMessageSize)
        }
        restoreBuffers()
    }

逻辑比较简单，就是不断从源segments里面读取数据，根据offsetMap和文件事件进行过滤，最后写回到新的segment里面。

下面具体来看怎么过滤记录的，过滤逻辑在`MemoryRecords.filterTo`方法中，这里不展开，只是看一下具体过滤规则，首先会调用`checkBatchRetention`如果返回了`DELETE`那直接就忽略了，对于其他两种情况，会根据返回值，以及`shouldRetainRecord`的结果确定是否保留：

    val logCleanerFilter = new RecordFilter {
        var discardBatchRecords: Boolean = _

        override def checkBatchRetention(batch: RecordBatch): BatchRetention = {
            // 要小心处理事务消息，事务里的所有记录都删了才能删事务
            discardBatchRecords = shouldDiscardBatch(batch, transactionMetadata, retainTxnMarkers = retainDeletes)

            // 检查是不是有了producer的最后序列号，有了才能删，要不然producer可能会看到乱序
            if (batch.hasProducerId && activeProducers.get(batch.producerId).contains(batch.lastSequence))
                BatchRetention.RETAIN_EMPTY  // 及时batch是空的也要保留
            else if (discardBatchRecords)
                BatchRetention.DELETE        // 直接删
            else
                BatchRetention.DELETE_EMPTY  // 如果batch是空的就删除
        }

        override def shouldRetainRecord(batch: RecordBatch, record: Record): Boolean = {
            if (discardBatchRecords)
                // The batch is only retained to preserve producer sequence information; the records can be removed
                false
            else
                Cleaner.this.shouldRetainRecord(map, retainDeletes, batch, record, stats)
        }
    }

## LogManager日志删除

而日志删除并不是在`LogCleaner`里面做的，是由`LogManager`中启动的回收线程来实现的，包括：

过期日志的删除

    // scheduler是在KafkaServer中创建的公用Scheduler
    scheduler.schedule("kafka-log-retention",
                        cleanupLogs _,
                        delay = 30 * 1000,
                        period = ${log.retention.check.interval.ms},
                        TimeUnit.MILLISECONDS)
    ...
    def cleanupLogs() {
        var total = 0
        for(log <- allLogs; if !log.config.compact) {
            total += log.deleteOldSegments()
        }
    }

