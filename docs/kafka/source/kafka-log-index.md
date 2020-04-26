---
title: 日志索引
date: 2018-06-28
state: completed
---

`LogSegment`对应于真实的日志文件，每个日志文件，还附带了三个索引文件：offset索引、时间索引和事务索引，其中事务索引和其它两个的实现不太一样，另外单讲。

offset和time索引的关系如图：

@startuml
AbstractIndex <|-- OffsetIndex
AbstractIndex <|-- TimeIndex
@enduml

它们采用稀疏索引的方式来构造，每个索引文件都不大，并通过`MappedByteBuffer`映射到内存来供`kafkaServer`操作。这几个类都不太长，基本展示了全部的源代码。

## AbstractIndex

简单啦来说，`AbstractIndex`定义了索引记录表如何和一个文件映射。子类需要指定每条索引项的大小：

    protected def entrySize: Int

构造方法中需要传入文件的上限（`maxIndexSize`），当索引文件不存在的时候设置文件长度，例如`entrySize = 8, maxIndexSize = 67`，那么最终的索引文件容量就是`64`：

    // 截断到单条索引大小的整数倍，例如 roundDownToExactMultiple(67, 8) == 64
    private def roundDownToExactMultiple(number: Int, factor: Int) = factor * (number / factor)

    raf.setLength(roundDownToExactMultiple(maxIndexSize, entrySize))

最终构造`MappedByteBuffer`，并封装基本的NIO操作，同时提供索引查找的通用方法。

具体来看`AbstractIndex`的代码结构：

    // maxIndexSize 是指定的最大字节数
    // file对应索引文件，文件名中会包含第一条日志消息的offset，即baseOffset
    abstract class AbstractIndex[K, V](@volatile var file: File, val baseOffset: Long,
                                       val maxIndexSize: Int = -1, val writable: Boolean) extends Logging {

        @volatile
        private var _length: Long = _            // 文件长度
        protected def entrySize: Int             // 抽象方法，定义一个索引项的大小
        protected val lock = new ReentrantLock   // 各种操作的锁

        @volatile
        protected var mmap: MappedByteBuffer = { 根据传入的file创建缓冲区 }

        @volatile
        private[this] var _maxEntries = mmap.limit() / entrySize   // 最大能存放的索引条数
        @volatile
        protected var _entries = mmap.position() / entrySize       // 已经加入的索引条数

        def isFull: Boolean = _entries >= _maxEntries              // 是否已经写满
        def maxEntries: Int = _maxEntries
        def entries: Int = _entries
        def length: Long = _length
        def sizeInBytes = entrySize * _entries                     // 已经使用量

        // 专门为windows设计的，在windows里面文件按被mmap之后是不能resize的，用于子类
        protected def maybeLock[T](lock: Lock)(fun: => T): T = {
            if (OperatingSystem.IS_WINDOWS)
                lock.lock()
            try fun
            finally {
                if (OperatingSystem.IS_WINDOWS)
                    lock.unlock()
            }
        }
    
        def sanityCheck(): Unit            // 抽象方法，做完整性检查，如果有问题抛出CorruptIndexException
    }

    object IndexSearchType extends Enumeration {
        type IndexSearchEntity = Value
        val KEY, VALUE = Value
    }

上面是基本属性，索引文件会被多个线程同时访问，所以很多成员都加了`@volatile`的注解，同时这个类里面定义了一些通用的NIO操作：

    // 1. 当Segment关闭或新Segment产生时触发 trimToValidSize 的时候会调用
    // 2. 当新Segment成为激活态，需要load老Segment并截断时调用
    def resize(newSize: Int): Boolean = {
        inLock(lock) {
            相当于重新指定maxIndexSize
            return 文件容量是否发生变化
        }
    }

    // 文件重命名
    def renameTo(f: File) {
        try Utils.atomicMoveWithFallback(file.toPath, f.toPath)
        finally file = f
    }

    // 刷新到磁盘
    def flush() {
        inLock(lock) { mmap.force() }
    }

    // 返回是否删除成功
    def deleteIfExists(): Boolean = {
        inLock(lock) { safeForceUnmap() }
        Files.deleteIfExists(file.toPath)  
    }

    // 删掉尾部还没有被填充的空间
    def trimToValidSize() {
        inLock(lock) { resize(entrySize * _entries) }
    }

    def close() { trimToValidSize() }          // 转为稳定索引文件

    def closeHandler(): Unit = {
        inLock(lock) { safeForceUnmap() }
    }

    // 清空所有索引项，并把文件容量上限重置为maxIndexSize
    def reset(): Unit = {
        truncate()
        resize(maxIndexSize)
    }

    protected def safeForceUnmap(): Unit = {
        try forceUnmap()
        catch { case t: Throwable => error(s"xxx", t) }
    }

    // 强制清空mmap，unmap之后如果再访问mmap，JVM会被SEGV信号终止，所以置null
    protected[log] def forceUnmap() {
        try MappedByteBuffers.unmap(file.getAbsolutePath, mmap)
        finally mmap = null 
    }

### 索引解析

定义了通用的解析方法，返回一个`IndexEntry对象`：

    // 定义在 kafka.log.IndexEntry
    // sealed trait IndexEntry {
    //     def indexKey: Long
    //     def indexValue: Long
    // }
    protected def parseEntry(buffer: ByteBuffer, n: Int): IndexEntry // 抽象方法，解析一条索引项

### 索引查找

在索引项里面搜索目标值，是用的是简单的二分查找，这里举几个例子来直观看功能，假设有索引项`[1 4 6 8]`：

* 要找0，返回`-1, indexOf(1)`
* 要找3，返回`indexOf(1), indexOf(4)`
* 要找4，返回`indexOf(4), indexOf(4)`
* 要找9，返回`indexOf(8), -1`

如果还没有索引项，查找任何目标都返回`(-1, -1)`，代码比较简单，不多做注释：

    // 查找离target最近的上下两个索引
    private def indexSlotRangeFor(idx: ByteBuffer, target: Long, searchEntity: IndexSearchEntity): (Int, Int) = {
        if(_entries == 0)
            return (-1, -1)

        // target小于第一个索引项
        if(compareIndexEntry(parseEntry(idx, 0), target, searchEntity) > 0)
            return (-1, 0)

        // 二分查找
        var lo = 0
        var hi = _entries - 1
        while(lo < hi) {
            val mid = ceil(hi/2.0 + lo/2.0).toInt
            val found = parseEntry(idx, mid)
            val compareResult = compareIndexEntry(found, target, searchEntity)
            if(compareResult > 0)
                hi = mid - 1
            else if(compareResult < 0)
                lo = mid
            else
                return (mid, mid)
        }

        (lo, if (lo == _entries - 1) -1 else lo + 1)
    }

    private def compareIndexEntry(indexEntry: IndexEntry, target: Long, searchEntity: IndexSearchEntity): Int = {
        searchEntity match {
            case IndexSearchType.KEY => indexEntry.indexKey.compareTo(target)
            case IndexSearchType.VALUE => indexEntry.indexValue.compareTo(target)
        }
    }

除此之外，又提供两个寻找单边的方法：

    // 小于等于target的最大索引项，例如索引项为[1 4 6 8]，需要找5，返回4，需要找4，也返回4
    protected def largestLowerBoundSlotFor(idx: ByteBuffer, target: Long, searchEntity: IndexSearchEntity): Int =
        indexSlotRangeFor(idx, target, searchEntity)._1

    // 大于等于target的最小索引项，例如索引项为[1 4 6 8]，需要找3，返回4，需要找4，也返回4
    protected def smallestUpperBoundSlotFor(idx: ByteBuffer, target: Long, searchEntity: IndexSearchEntity): Int =
        indexSlotRangeFor(idx, target, searchEntity)._2

这几个方法都用于子类。

### 索引截断

父类中定义了两个截断的抽象方法，需要在子类中实现

    protected def truncate(): Unit     // 抽象方法，删除所有索引项
    def truncateTo(offset: Long): Unit // 抽象方法，删除大于等于offset的索引项

## OffsetIndex

`OffsetIndex`在`kafka 0.8`中引进，为了提高查找消息的性能，为每个日志文件维护一个offset到记录项位置的索引。

每条索引项由两个`int`值构成，第一部分对应partition的offset，因为每个logSegment文件的文件名都包括`baseOffset`，所以只需要一个`int`的长度就能表示一个offset，第二部分是消息在日志文件中的物理位置。

    class OffsetIndex(_file: File, baseOffset: Long, maxIndexSize: Int = -1, writable: Boolean = true)
        extends AbstractIndex[Long, Int](_file, baseOffset, maxIndexSize, writable) {

        override def entrySize = 8                        // 覆写父类的定义，两个int共8字节
        private[this] var _lastOffset = lastEntry.offset  // 最后一条索引项的offset
        def lastOffset: Long = _lastOffset

        override def sanityCheck() {
            // 最后索引项的offset一定不小于第一条索引项的offset
            if (_entries != 0 && _lastOffset <= baseOffset)
                throw new CorruptIndexException(s"Corrupt index found, index file ...")
            // 索引文件长度一定是单条索引项大小的整数倍
            if (length % entrySize != 0)
                throw new CorruptIndexException(s"Index file ${file.getAbsolutePath} is corrupt ...")
        }

    }

### Offset索引解析

根据每条索引项的结构，可以很容易地还原一个`OffsetPosition(offset, position)`，需要注意的是，有的接口返回的`offset`是真实的包含了`baseOffset`的偏移量，也就是long型偏移量，代码注释里面称之为绝对偏移量，有的是在索引文件中保存的int型偏移量，即减掉了baseOffset的值，代码注释里面称之为相对偏移量：

    // 定义在 kafka.log.IndexEntry
    // case class OffsetPosition(offset: Long, position: Int) extends IndexEntry {
    //     override def indexKey = offset
    //     override def indexValue = position.toLong
    // }

    private def lastEntry: OffsetPosition = {         // 解析最后一条索引项，offset是long型绝对偏移
        inLock(lock) {
            _entries match {
                case 0 => OffsetPosition(baseOffset, 0)
                case s => parseEntry(mmap, s - 1).asInstanceOf[OffsetPosition]
            }
        }
    }

    // 从索引项里面解析出int型相对偏移量
    private def relativeOffset(buffer: ByteBuffer, n: Int): Int = buffer.getInt(n * entrySize)

    // 从索引项里面解析出消息在日志文件中的位置
    private def physical(buffer: ByteBuffer, n: Int): Int = buffer.getInt(n * entrySize + 4)

    // 解析真实的 offset -> position 的映射，offset是long型绝对偏移量
    override def parseEntry(buffer: ByteBuffer, n: Int): IndexEntry = {
        OffsetPosition(baseOffset + relativeOffset(buffer, n), physical(buffer, n))
    }

    // 解析原始的索引项，offset是int型相对偏移量
    def entry(n: Int): OffsetPosition = {
        maybeLock(lock) {
            if(n >= _entries) throw new IllegalArgumentException("...")
            val idx = mmap.duplicate
            OffsetPosition(relativeOffset(idx, n), physical(idx, n))
        }
    }

### Offset索引查找

索引查找借助了`AbstractIndex`里面定义的二分查找实现：

* `lookup` - 查找目标offset所对应的索引项，例如索引项的offset是[1 4 6 8]，要查找4或5都返回4，如果目标小于第一条索引项，返回 OffsetPosition(baseOffset, 0)
* `fetchUpperBoundOffset` - 查找目标offset所对应的下一个索引项，例如索引项的offset是[1 4 6 8]，要查找5或6都返回6，如果目标大于最后一条索引项，返回 None

`largestLowerBoundSlotFor`和`smallestUpperBoundSlotFor`的实现参照前面AbstractIndex的代码。

    // 查找目标offset所对应的索引项
    def lookup(targetOffset: Long): OffsetPosition = {
        maybeLock(lock) {
            val idx = mmap.duplicate
            val slot = largestLowerBoundSlotFor(idx, targetOffset, IndexSearchType.KEY)
            if(slot == -1)
                OffsetPosition(baseOffset, 0)
            else
                parseEntry(idx, slot).asInstanceOf[OffsetPosition]
        }
    }

    // 查找目标offset所对应的下一个索引项
    def fetchUpperBoundOffset(fetchOffset: OffsetPosition, fetchSize: Int): Option[OffsetPosition] = {
        maybeLock(lock) {
            val idx = mmap.duplicate
            val slot = smallestUpperBoundSlotFor(idx, fetchOffset.position + fetchSize, IndexSearchType.VALUE)
            if (slot == -1)
                None
            else
                Some(parseEntry(idx, slot).asInstanceOf[OffsetPosition])
        }
    }

### Offset索引添加

往文件里添加新的索引项 ，参数offset是包括了baseOffset的原始值。

    def append(offset: Long, position: Int) {
        inLock(lock) {
            require(!isFull, "...")
            if (_entries == 0 || offset > _lastOffset) { // 保证索引项的offset是递增的
                mmap.putInt((offset - baseOffset).toInt)
                mmap.putInt(position)
                _entries += 1
                _lastOffset = offset
                require(_entries * entrySize == mmap.position(), "...") // 确保NIO操作之后文件position是对的
            } else {
                throw new InvalidOffsetException("...")
            }
        }
    }

### Offset索引截断

* `truncate()` - 删除所有索引
* `truncateTo(offset: Long)` - 删除大于等于offset的所有索引，offset是减掉了baseOffset的值

实际截断操作就是计算出正确的有效索引项占据的字节数，重置`MappedByteBuffer`的`position`：

    override def truncate() = truncateToEntries(0)

    override def truncateTo(offset: Long) {
        inLock(lock) {
            val idx = mmap.duplicate
            val slot = largestLowerBoundSlotFor(idx, offset, IndexSearchType.KEY)

            val newEntries =
                if(slot < 0)  
                    0          // offset小于第一条索引项，删除所有索引
                else if(relativeOffset(idx, slot) == offset - baseOffset)  
                    slot       // 正好有一条等于offset的索引项，例如在[1 4 6 8]里面删4，最后新长度就是1
                else
                    slot + 1   // 没有正好等于offset的索引项，例如在[1 4 6 8]里面删5，最后新长度就是2
            truncateToEntries(newEntries)
        }
    }

    private def truncateToEntries(entries: Int) {
        inLock(lock) {
            _entries = entries
            mmap.position(_entries * entrySize)
            _lastOffset = lastEntry.offset
        }
    }

## TimeIndex

`TimeIndex`为每个日志文件维护一个时间戳到offset的索引。

每条索引项由一个`long`和一个`int`值构成，第一部分对应时间戳，第二部分对应`offset`，和`OffsetIndex`一样，因为每个logSegment文件的文件名都包括`baseOffset`，所以只需要一个`int`的长度就能表示一个offset。

    class TimeIndex(_file: File, baseOffset: Long, maxIndexSize: Int = -1, writable: Boolean = true)
        extends AbstractIndex[Long, Long](_file, baseOffset, maxIndexSize, writable) with Logging {

        override def entrySize = 12    // // 覆写父类的定义，一个long一个int共12字节

        // 父类的公共实现是 _entries >= _maxEntries，滚动到新文件的时候，需要留个空反转最后的索引项
        override def isFull: Boolean = entries >= maxEntries - 1

        // 重写resize，加上 _lastEntry 的更新
        override def resize(newSize: Int): Boolean = {
            inLock(lock) {
                if (super.resize(newSize)) {
                    _lastEntry = lastEntryFromIndexFile
                    true
                } else 
                    false
            }
        }

        // 完整性检查，maybeAppend的时候，也会做类似的检查
        override def sanityCheck() {
            val lastTimestamp = lastEntry.timestamp
            val lastOffset = lastEntry.offset
            // 最后索引项的时间戳一定不小于第一条索引项的时间戳
            if (_entries != 0 && lastTimestamp < timestamp(mmap, 0))
                throw new CorruptIndexException(s"Corrupt time index found ...")
            // 最后索引项的offset一定不小于第一条索引项的offset
            if (_entries != 0 && lastOffset < baseOffset)
                throw new CorruptIndexException(s"Corrupt time index found ...")
            // 索引文件长度一定是单条索引项大小的整数倍
            if (length % entrySize != 0)
                throw new CorruptIndexException(s"Time index file ${file.getAbsolutePath} is corrupt ...")
        }
    }


### Time索引解析

根据每条索引项的结构，可以很容易地还原一个`TimestampOffset(timestamp, offset)`，需要注意的是，有的接口返回的`offset`是真实的包含了`baseOffset`的偏移量，也就是long型偏移量，代码注释里面称之为绝对便宜量，有的是在索引文件中保存的int型偏移量，即减掉了baseOffset的值，代码注释里面称之为相对偏移量：

    // 定义在 kafka.log.IndexEntry
    // case class TimestampOffset(timestamp: Long, offset: Long) extends IndexEntry {
    //     override def indexKey = timestamp
    //     override def indexValue = offset
    // }

    // 从索引项里面解析出long型时间戳
    private def timestamp(buffer: ByteBuffer, n: Int): Long = buffer.getLong(n * entrySize)
    // 从索引项里面解析出int型偏移量
    private def relativeOffset(buffer: ByteBuffer, n: Int): Int = buffer.getInt(n * entrySize + 8)

    @volatile private var _lastEntry = lastEntryFromIndexFile
    def lastEntry: TimestampOffset = _lastEntry

    private def lastEntryFromIndexFile: TimestampOffset = { // 解析最后一条索引
        inLock(lock) {
            _entries match {
                case 0 => TimestampOffset(RecordBatch.NO_TIMESTAMP, baseOffset)
                case s => parseEntry(mmap, s - 1).asInstanceOf[TimestampOffset]
            }
        }
    }

    def entry(n: Int): TimestampOffset = {   // 解析第N条索引，value是相对offset
        maybeLock(lock) {
            if(n >= _entries) throw new IllegalArgumentException("...")
            val idx = mmap.duplicate
            TimestampOffset(timestamp(idx, n), relativeOffset(idx, n))
        }
    }

    // value是绝对偏移量
    override def parseEntry(buffer: ByteBuffer, n: Int): IndexEntry = {
        TimestampOffset(timestamp(buffer, n), baseOffset + relativeOffset(buffer, n))
    }

### Time索引查找

查找timestamp小于等于待查找值的索引项，如果第一条索引也大于要查找的值，则返回`TimestampOffset(NoTimestamp, baseOffset)`。

    def lookup(targetTimestamp: Long): TimestampOffset = {
        maybeLock(lock) {
            val idx = mmap.duplicate
            val slot = largestLowerBoundSlotFor(idx, targetTimestamp, IndexSearchType.KEY)
            if (slot == -1)
                TimestampOffset(RecordBatch.NO_TIMESTAMP, baseOffset)
            else {
                val entry = parseEntry(idx, slot).asInstanceOf[TimestampOffset]
                TimestampOffset(entry.timestamp, entry.offset)
            }
        }
    }

### Time索引添加

追加一条索引，一般情况下，timestamp一定要大于最后一条索引的timestamp。

最后有个参数`skipFullCheck`，指定是否跳过Segment已满的检查，当要滚动到新segment（`LogSegment.onBecomeInactiveSegment()`）或当前segment要close的时候，需要跳过检查。

另外，当上述两种情况发生的时候，新插入索引的timestamp有可能等于最后一条索引，这时候忽略插入，不抛异常。

    def maybeAppend(timestamp: Long, offset: Long, skipFullCheck: Boolean = false) {
        inLock(lock) {
            if (!skipFullCheck) require(!isFull, "Attempt to append to a full time index ...")
            if (_entries != 0 && offset < lastEntry.offset)       // 新索引的offset小于最后一条索引
                throw new InvalidOffsetException("Attempt to append ...")
            if (_entries != 0 && timestamp < lastEntry.timestamp) // 新索引的时间戳小于最后一条索引
                throw new IllegalStateException("Attempt to append ...")
      
            // 消息的格式版本为V0的时候，不会携带时间戳信息，时间戳会恒等于 NoTimestamp ( = -1)
            if (timestamp > lastEntry.timestamp) {
                mmap.putLong(timestamp)
                mmap.putInt((offset - baseOffset).toInt)
                _entries += 1
                _lastEntry = TimestampOffset(timestamp, offset)
                require(_entries * entrySize == mmap.position(), "...") // 校对文件有效内容长度
            }
        }
    }

### Time索引截断

Time和Offset的索引截断实现，几乎没有啥差别：

* `truncate()` - 删除所有索引
* `truncateTo(offset: Long)` - 删除大于等于offset的所有索引，offset是减掉了baseOffset的相对值，没错，Time索引截断并不是根据时间戳来做截断的，而是根据Offset值，也就是根据索引的`IndexSearchType.VALUE`来确定截断的位置。

和Offset索引截断一样，实际截断操作是计算出正确的有效索引项占据的字节数，重置MappedByteBuffer的position：

    override def truncate() = truncateToEntries(0)

    override def truncateTo(offset: Long) {
        inLock(lock) {
            val idx = mmap.duplicate
            val slot = largestLowerBoundSlotFor(idx, offset, IndexSearchType.VALUE)

            val newEntries =
                if(slot < 0)
                    0           // offset小于第一条索引项，删除所有索引
                else if(relativeOffset(idx, slot) == offset - baseOffset)
                    slot        // 正好有一条等于offset的索引项，例如在[1 4 6 8]里面删4，最后新长度就是1
                else
                    slot + 1    // 没有正好等于offset的索引项，例如在[1 4 6 8]里面删5，最后新长度就是2
            truncateToEntries(newEntries)
        }
    }

    private def truncateToEntries(entries: Int) {
        inLock(lock) {
            _entries = entries
            mmap.position(_entries * entrySize)
            _lastEntry = lastEntryFromIndexFile
        }
    }
