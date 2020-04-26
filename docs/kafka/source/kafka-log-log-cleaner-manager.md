---
title: 日志压缩的管理
date: 2018-06-28
state: inprogress
---

`kafka.log.LogCleanerManager`管理每个partition的日志压缩状态，它的状态转换图是：

    TODO: ADD IMAGE

通过构造函数来看：

    private[log] class LogCleanerManager(val logDirs: Seq[File],
                    val logs: Pool[TopicPartition, Log],
                    val logDirFailureChannel: LogDirFailureChannel) extends ... {

        private[log] val offsetCheckpointFile = "cleaner-offset-checkpoint"

        @volatile private var checkpoints = logDirs.map(dir =>
            (dir, new OffsetCheckpointFile(new File(dir, offsetCheckpointFile), logDirFailureChannel))).toMap

        private val inProgress = mutable.HashMap[TopicPartition, LogCleaningState]()
        ...
    }

`checkpoints`保存每个日志最后压缩的位置。

`logs`是每个Partition对应的日志集，这个集合有可能会变化。

## 计算最应该压缩的日志

`grabFilthiestCompactedLog`方法找出下一次应该进行压缩的日志，并标记为`InProgress`状态，因为`logs`集合石可变的，随时有可能加入新的日志集，所以每次调用这个方法的时候都会重新计算。

    def grabFilthiestCompactedLog(time: Time): Option[LogToClean] = {
        inLock(lock) {
            val now = time.milliseconds
            this.timeOfLastRun = now
            val lastClean = allCleanerCheckpoints
            val dirtyLogs = logs.filter {
                case (_, log)            => log.config.compact  // 过滤配置了压缩的日志
            }.filterNot {
                case (topicPartition, _) => inProgress.contains(topicPartition) // 跳过处理中的
            }.map { case (topicPartition, log) =>
                // 计算各个日志应该进行压缩的offset上下界
                val (firstDirtyOffset, firstUncleanableDirtyOffset) = LogCleanerManager.cleanableOffsets(log, topicPartition, lastClean, now)
                LogToClean(topicPartition, log, firstDirtyOffset, firstUncleanableDirtyOffset)
            }.filter(ltc => ltc.totalBytes > 0) // 跳过空的日志

            val cleanableLogs = dirtyLogs.filter(ltc => ltc.cleanableRatio > ltc.log.config.minCleanableRatio)
            if(cleanableLogs.isEmpty) {
                None
            } else {
                val filthiest = cleanableLogs.max
                inProgress.put(filthiest.topicPartition, LogCleaningInProgress)
                Some(filthiest)
            }
        }
    }

    // 所有日志已经处理过的位置（删了异常处理）
    def allCleanerCheckpoints: Map[TopicPartition, Long] = {
        inLock(lock) {
            checkpoints.values.flatMap(checkpoint => checkpoint.read()).toMap
        }
    }

第一步是找到所有符合条件的日志，然后根据一个清理频率来进行过滤。这里面最关键的就是`cleanableOffsets`方法，返回一个应该压缩的左闭右开的offset区间，其中：

* 下界是上次已经清理到的位置，如果之前未清理过，或者日志已经truncate到比checkpoint更靠后的位置，那么重置到日志开始的位置；
* 上界是下面三种case的最小offset：
    * 最老的未提交事务消息的offset
    * 还处于active状态的（还在写入的）segment的offset
    * 最新消息和当前时间非常接近的segment的offset

具体逻辑代码：

    def cleanableOffsets(log: Log, topicPartition: TopicPartition, lastClean: immutable.Map[TopicPartition, Long], now: Long): (Long, Long) = {

        // 上次清理到什么位置了
        val lastCleanOffset: Option[Long] = lastClean.get(topicPartition)

        // 如果日志执行过truncate操作，那么之前的checkpoint就失效了，需要重新算
        val logStartOffset = log.logSegments.head.baseOffset
        val firstDirtyOffset = {
            val offset = lastCleanOffset.getOrElse(logStartOffset)
            if (offset < logStartOffset) {
                // 如果开启了compact或delete的话打印日志
                logStartOffset
            } else {
                offset
            }
        }

        val compactionLagMs = math.max(log.config.compactionLagMs, 0L)
        val firstUncleanableDirtyOffset: Long = Seq(
            log.firstUnstableOffset.map(_.messageOffset), // 事务未提交的排除
            Option(log.activeSegment.baseOffset),         // 还在写入的排除
            if (compactionLagMs > 0) {                    // 时间太近的排除
                val dirtyNonActiveSegments = log.logSegments(firstDirtyOffset, log.activeSegment.baseOffset)
                dirtyNonActiveSegments.find { s =>
                    val isUncleanable = s.largestTimestamp > now - compactionLagMs
                    isUncleanable
                }.map(_.baseOffset)
            } else None
        ).flatten.min

        (firstDirtyOffset, firstUncleanableDirtyOffset)
    }

在前面`grabFilthiestCompactedLog`代码中，得到所有应该压缩的日志之后还做了一层过滤：

    val cleanableLogs = dirtyLogs.filter(ltc => ltc.cleanableRatio > ltc.log.config.minCleanableRatio)

看一下`LogToClean`里面对于`cleanableRatio`的计算：

    val cleanBytes = log.logSegments(-1, firstDirtyOffset).map(_.size.toLong).sum
    val cleanableBytes = log.logSegments(firstDirtyOffset, math.max(firstDirtyOffset, firstUncleanableOffset)).map(_.size.toLong).sum
    val totalBytes = cleanBytes + cleanableBytes
    val cleanableRatio = cleanableBytes / totalBytes.toDouble

简单说就是（TODO：已经压缩过的字节数是原始字节数还是压缩后的字节数）：

    cleanableRatio = 这次准备压缩的字节数 / (这次准备压缩的字节数 + 已经压缩过的字节数)

最后会在所有`cleanableRatio`大于配置`min.cleanable.dirty.ratio`的日志里面选择`cleanableRatio`最大的那个作为最应该进行压缩的日志。
