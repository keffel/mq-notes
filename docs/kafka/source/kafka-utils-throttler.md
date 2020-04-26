---
title: 工具 节流阀 Throttle
date: 2018-06-06
state: COMPLETED
---

## Throttle用在哪里

`kafka.utils.Throttle`定义了一个节流组件，截止`1.1.0`，只用在：

* 控制日志压缩速度上（`LogCleaner`）。

## Throttle工作方式

打个比方来说明限速的工作方式。

一个人骑自行车行驶在时速不能超过6km（100米/分钟）的路上，路边会有牌子指示距离上一个牌子走了多远，如1km、2km，那么他可以在每次看到牌子的时候看一下手表：
* 如果距离上次估算速度在5分钟以内，就继续骑；
* 如果超过5分钟，就估算一下这两点间的平均速度：
    - 如果没有超速继续骑；
    - 超速就休息，直到这段时间的平均速度落回规定以内再重新出发。

可能会出现下面的轨迹：

* 在时刻0的时候出发了；
* 骑到500米牌子的时候看了一眼手表，已经走了4分钟，还不到5分钟的检查时间，继续骑；
* 又骑到500米牌子的时候看手表，又过了4分钟，一共走了8分钟，发现平均每分钟走了125米，超速了，到现在的1000米应该用10分钟，只用了8分钟就到了，所以休息两分钟再出发；
* 再出发的时候重置时间到时刻0，总共走过的距离也重置为0，重新开始计数。

我们把骑行的距离称为资源数量，每过5分钟检查一次称为检查间隔，当通过的资源数量超过设定值的时候，需要休眠。

还有另外一种状况，例如在理财，可能有这种需求：
* 当每个月赚钱数超过-1000（赔钱在1000以内）的时候随便玩；
* 低于-1000的时候就歇歇缓一缓再来。

这时候，赚的钱是资源数量，一个月是检查间隔，通过的资源数量小于设定值的时候需要休眠。

明白了场景和原来再来看这个类，这个类非常短，包括打点的代码都完整贴出来，首先来看构造器：

    class Throttler(desiredRatePerSec: Double,     // 每秒允许通过的资源数量
                    checkIntervalMs: Long = 100L,  // 检查间隔
                    throttleDown: Boolean = true,  // 控制速度在限定值之下还是之上，默认是之下
                    metricName: String = "throttler",  // 统计打点用
                    units: String = "entries",         // 统计打点用
                    time: Time = Time.SYSTEM) extends Logging with KafkaMetricsGroup {
  
        private val lock = new Object
        private val meter = newMeter(metricName, units, TimeUnit.SECONDS)
        private val checkIntervalNs = TimeUnit.MILLISECONDS.toNanos(checkIntervalMs)
        private var periodStartNs: Long = time.nanoseconds  // 当前时间段的开始时间
        private var observedSoFar: Double = 0.0             // 当前时间段已经通过的资源数
        
        def maybeThrottle(observed: Double) = ...
    }

## 检查限速

`Throttle`只有唯一一个方法`maybeThrottle`，参数是本次希望通过的资源数量：

    def maybeThrottle(observed: Double) {
        val msPerSec = TimeUnit.SECONDS.toMillis(1)
        val nsPerSec = TimeUnit.SECONDS.toNanos(1)

        meter.mark(observed.toLong)
        lock synchronized {
            observedSoFar += observed
            val now = time.nanoseconds
            val elapsedNs = now - periodStartNs  // 当前时间段已经持续了多久
            // 如果上一个时间段结束了
            if (elapsedNs > checkIntervalNs && observedSoFar > 0) {
                val rateInSecs = (observedSoFar * nsPerSec) / elapsedNs // 换算成每秒的流量
                // throttleDown == true 并且超过限定速度了需要调整
                // throttleDown == false 并且低于限定速度了需要调整
                val needAdjustment = !(throttleDown ^ (rateInSecs > desiredRatePerSec))
                if (needAdjustment) {
                    val desiredRateMs = desiredRatePerSec / msPerSec.toDouble
                    val elapsedMs = TimeUnit.NANOSECONDS.toMillis(elapsedNs)
                    // 通过当前的资源应该用多久，减去实际用了多久，就是应该休眠的时间
                    val sleepTime = round(observedSoFar / desiredRateMs - elapsedMs)
                    if (sleepTime > 0) {
                        trace("Natural rate is %f per second but desired rate is %f, sleeping for %d ms to compensate.".format(rateInSecs, desiredRatePerSec, sleepTime))
                        time.sleep(sleepTime)
                    }
                }
                periodStartNs = now
                observedSoFar = 0
            }
        }
    }

`throttleDown == false`的情况不是很好理解，在代码里面并没有相应的case，只能想到不能低于一个负的速度的场景。
