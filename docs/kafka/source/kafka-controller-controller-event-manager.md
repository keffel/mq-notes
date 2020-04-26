---
title: KafkaController的事件管理
date: 2018-05-25
state: completed
---

`kafka.controller.ControllerEventManager`是`KafkaController`的事件管理中心，它通过一个内存队列来完成事件发起者和事件处理者之间的解耦。

    class ControllerEventManager(controllerId: Int, rateAndTimeMetrics: Map[ControllerState, KafkaTimer],
                                 eventProcessedListener: ControllerEvent => Unit) {

        @volatile private var _state: ControllerState = ControllerState.Idle
        private val putLock = new ReentrantLock()   // 保证queue的写入是线程安全的
        private val queue = new LinkedBlockingQueue[ControllerEvent]、
        private val thread = new ControllerEventThread("controller-event-thread")

        def state: ControllerState = _state

        def start(): Unit = thread.start()

        def close(): Unit = {
            clearAndPut(KafkaController.ShutdownEventThread)
            thread.awaitShutdown()
        }

        def put(event: ControllerEvent): Unit = inLock(putLock) {
            queue.put(event)
        }
        // 当Close或者ZK Session超时的时候，需要清空未处理的事件，
        // 并发送一个结束事件（ShutdownEventThread or Expire）
        def clearAndPut(event: ControllerEvent): Unit = inLock(putLock) {
            queue.clear()
            queue.put(event)
        }

        class ControllerEventThread(name: String) ... {}
    }

`ControllerEvent`是`KafkaController`的内部类，定义了`ControllerState`和事件行为：

    sealed trait ControllerEvent {
        def state: ControllerState
        def process(): Unit
    }

因为有了`sealed`修饰，所有`ControllerEvent`都必须实现在`KafkaController`里面。

事件被压入内存队列之后，由异步线程`ControllerEventThread`处理：

    class ControllerEventThread(name: String) extends ShutdownableThread(name = name, false) {

        override def doWork(): Unit = {
            queue.take() match {
                // initiateShutdown是ShutdownableThread的关闭逻辑
                case KafkaController.ShutdownEventThread => initiateShutdown() 
                case controllerEvent =>
                    _state = controllerEvent.state

                    // 忽略了 rateAndTimeMetrics 统计 process 时间的代码
                    try controllerEvent.process() catch { ... }
                    try eventProcessedListener(controllerEvent) catch { ... }

                    _state = ControllerState.Idle
            }
        }
    }
