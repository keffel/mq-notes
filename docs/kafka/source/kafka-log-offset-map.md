---
title: 日志组件 OffsetMap
date: 2018-06-06
state: COMPLETED
---

## OffsetMap接口定义

`kafka.log.OffsetMap`可以看作是`Map[byte[], Long]`，记录key到offset的映射关系。

    trait OffsetMap {
        def slots: Int                                  // map的最大容量（记录数）
        def put(key: ByteBuffer, offset: Long)          // 写入key和offset的映射
        def get(key: ByteBuffer): Long                  // 获取key对应的offset值
        def updateLatestOffset(offset: Long)            // 更新最后写入的log offset值
        def clear()                                     // 清空map
        def size: Int                                   // 已经写入的记录数
        def utilization: Double = size.toDouble / slots // 使用比例
        def latestOffset: Long                          // 最后写入的log offset值
    }

这个集合类仅用于`LogCleaner`，在日志压缩时做日志去重。

## SkimpyOffsetMap实现

`kafka.log.SkimpyOffsetMap`是`OffsetMap`的唯一实现，相当于`HashMap[byte[], Long]`，`skimpy`意思是吝啬的，对key做一个安全的哈希来节省存储空间，使用探测来解决冲突，不支持删除。

    @nonthreadsafe
    class SkimpyOffsetMap(val memory: Int, val hashAlgorithm: String = "MD5") extends OffsetMap {
        private val bytes = ByteBuffer.allocate(memory)  // map的总内存大小
        private val digest = MessageDigest.getInstance(hashAlgorithm) // key的映射算法
        private val hashSize = digest.getDigestLength    // hash算法生成的结果长度
        private val hash1 = new Array[Byte](hashSize)    // 避免每次重新分配空间，缓存要查找的key
        private val hash2 = new Array[Byte](hashSize)    // 避免每次重新分配空间，缓存正遍历的key
        private var entries = 0                          // map的size
        private var lookups = 0L                         // put和get的调用次数
        private var probes = 0L                          // 哈希冲突之后总的探测次数
        private var lastOffset = -1L                     // map最后一次写入（更新）的value
        val bytesPerEntry = hashSize + 8                 // 每个日志项占用的字节数（K+V）
        val slots: Int = memory / bytesPerEntry          // map的容量（maxSize）

        override def size: Int = entries
        override def latestOffset: Long = lastOffset
        override def updateLatestOffset(offset: Long): Unit = { lastOffset = offset }
        ... (other methods)
    }

根据构造定义可以看出：
1. 线程不安全
2. 需要预定义内存大小（`ByteBuffer`的大小）

`hash1`和`hash2`这两个只是对Key做一个映射，让Key变成等长的字符串，并不等同于`hashCode`方法的作用。

### 写入KV

`put`方法定义了写入KV对的逻辑：

    override def put(key: ByteBuffer, offset: Long) {
        require(entries < slots, "Attempt to add a new entry to a full offset map.")
        lookups += 1
        hashInto(key, hash1)   // 使用指定的digest计算哈希，结果写入hash1，这里导致了线程不安全
        var attempt = 0        // 哈希冲突的散列探测次数
        var pos = positionOf(hash1, attempt)   // 根据冲突次数获得新的散列位置
        while(!isEmpty(pos)) {
            bytes.position(pos)
            bytes.get(hash2)
            if(Arrays.equals(hash1, hash2)) {  // 如果Key已经有值则更新value
                bytes.putLong(offset)
                lastOffset = offset
                return
            }
            attempt += 1
            pos = positionOf(hash1, attempt)
        }
        bytes.position(pos)    // 写入新的KV对
        bytes.put(hash1)
        bytes.putLong(offset)
        lastOffset = offset
        entries += 1
    }

`positionOf`会根据已经冲突的次数（`attempt`）来计算新的hash位置，策略是：

* 首次把hash的0-3字节读到int里，对slots取模得到位置；
* 冲突后把hash的1-4字节读到int里，对slots取模得到位置；
* hash的最后4字节构成的int依然冲突，进入线性探测，每次+1，对slots取模得到位置；

这段策略就体现在`probe`变量的计算上：

    private def positionOf(hash: Array[Byte], attempt: Int): Int = {
        val probe = CoreUtils.readInt(hash, math.min(attempt, hashSize - 4)) + math.max(0, attempt - hashSize + 4)
        val slot = Utils.abs(probe) % slots
        this.probes += 1
        slot * bytesPerEntry
    }

而判断一个位置上是不是已经有值，方法很简单，判断Key的前24位是不是都是0：

    private def isEmpty(position: Int): Boolean = 
        bytes.getLong(position) == 0 && bytes.getLong(position + 8) == 0 && bytes.getLong(position + 16) == 0

### 读取KV

`get`和`put`的逻辑基本是一样的：

    override def get(key: ByteBuffer): Long = {
        lookups += 1
        hashInto(key, hash1)    // 使用指定的digest计算哈希，结果写入hash1，这里导致了线程不安全
        var attempt = 0         // 寻找Key的Hash位置，冲突后重新散列，直到找到或者碰到空的位置
        var pos = 0
        val maxAttempts = slots + hashSize - 4 // map已满且没有目标元素的话，会无限循环，需要限制查找次数
        do {
            if(attempt >= maxAttempts)
                return -1L      // map已经满了，探测了一个遍，返回没找到
            pos = positionOf(hash1, attempt)
            bytes.position(pos)
            if(isEmpty(pos))
                return -1L
            bytes.get(hash2)
            attempt += 1
        } while(!Arrays.equals(hash1, hash2))
        bytes.getLong()
    }

这里需要说明的是最大探测次数的计算方式：

    val maxAttempts = slots + hashSize - 4

因为探测的第一阶段是根据key的digest顺序读取int来做hash，是有可能重复的，所以探测终止的条件并不是探测了slots次，而是进入线性探测阶段之后，又探测了slots次还没找到才停止。

### 清空map

clear方法重置各种状态：

    override def clear() {
        this.entries = 0
        this.lookups = 0L
        this.probes = 0L
        this.lastOffset = -1L
        Arrays.fill(bytes.array, bytes.arrayOffset, bytes.arrayOffset + bytes.limit(), 0.toByte)
    }

### 统计冲突率

在前面的代码里，每次`get`和`put`方法被调用的时候`lookups`会`+1`，每次`positionOf`散列一个新位置的时候`probes`会`+1`，根据这两个变量可以计算冲突率：

    def collisionRate: Double = (this.probes - this.lookups) / this.lookups.toDouble

最优状态下，`lookups == probes`也就是没有冲突，冲突次数过多的情况下要考虑增加`slots`也就是`momery`来提高性能。

注：冲突率只用在了测试代码里，没有线上的监控。
