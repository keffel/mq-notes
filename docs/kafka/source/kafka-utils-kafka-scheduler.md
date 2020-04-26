---
title: 工具 调度器 KafkaScheduler
date: 2018-04-11
---

## Scheduler接口

在`kafka.utils`包里定义了一个`Scheduler`接口，支持周期性地执行单个任务，或者延迟执行一次：

    trait Scheduler {
        
        /* 初始化 */
        def startup()
     
        /* 关闭包括未执行的延迟任务在内的所有任务 */
        def shutdown()
     
        /* 检查是否启动 */
        def isStarted: Boolean
     
        /**
         * 调度一个任务
         * @param name 任务名
         * @param delay 首次运行前的等待时间
         * @param period 执行周期，负数表示只执行一次
         * @param unit delay / period 时间的单位
         */
        def schedule(name: String, fun: ()=>Unit, delay: Long = 0, period: Long = -1, 
                     unit: TimeUnit = TimeUnit.MILLISECONDS)
    }

## KafkaScheduler

`KafkaScheduler`是一个任务调度器，线程安全：

    @threadsafe
    class KafkaScheduler(val threads: Int, 
                     val threadNamePrefix: String = "kafka-scheduler-", 
                     daemon: Boolean = true) extends Scheduler with Logging {
        private var executor: ScheduledThreadPoolExecutor = null
        private val schedulerThreadId = new AtomicInteger(0)

它是对`ScheduledThreadPoolExecutor`的封装，并自定义了ThreadFactory，需要创建线程的时候，会创建一个`org.apache.kafka.common.utils.KafkaThread`的对象：

    executor = new ScheduledThreadPoolExecutor(threads)
    executor.setContinueExistingPeriodicTasksAfterShutdownPolicy(false)
    executor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false)
    executor.setThreadFactory(new ThreadFactory() {
        def newThread(runnable: Runnable): Thread = 
            new KafkaThread(threadNamePrefix + schedulerThreadId.getAndIncrement(), runnable, daemon)
        })

`KafkaThread`继承了`Thread`，在`Thread`的功能之外，添加了：

1. 在构造对象的时候指定是否以daemon的形式运行；
2. 如果任务执行中抛出了未捕获的异常，打印日志。

综合`KafkaThread`的功能，对于`KafkaScheduler`这个工具类，可以理解为拥有以下的特点：

1. 可以在构造器中指定线程池大小；
2. 执行调度任务的线程，线程名为：`kafka-scheduler-${autoIncrementSequence}`；
3. 在构造器中指定运行调度任务的线程是守护（daemon）线程还是普通用户态线程；
4. 如果调度任务中出现未捕获的异常，会打印线程名及异常栈；
5. 可以单次执行一个任务，或以固定周期运行（`scheduleAtFixedRate`）。

一般情况下，线程池大小都是1，来周期性运行单个任务，在`KafkaServer`中会比较特殊，会读取`background.threads (default 10)`配置值来同时运行多个后台线程。

## KafkaScheduler用在哪里

`KafkaScheduler`会在下面的场景中被用到：

1. `KafkaController`初始化的时候；
2. `GroupMetadataManager`初始化的时候；
3. `KafkaServer`调用`startUp`的时候；
4. `ZooKeeperClient`初始化的时候；
5. `LogManager`初始化的时候；
6. `TransactionCoordinator`初始化的时候。

## KafkaScheduler的API

通过API可以更好的理解这个类是干什么的。

### Constructor

    new KafkaScheduler(threads, threadNamePrefix, daemon)

对应的参数是：

* `threads: int` - 线程池大小
* `threadNamePrefix: String` - 线程名前缀，后面会缀上一个自增的序号，每个Scheduler都是从0开始，默认为`"kafka-scheduler-"`；
* `daemon: boolean` - 是否以守护线程形态运行，默认为`true`

### 启动Scheduler

    startup()

在提交具体任务之前，要先调用`startup`方法，调度任务可以多次（`shutdown`）关闭和开启（`startup`），每次`startup`之后，执行线程的名字都会变，也就是`"kafka-scheduler-${autoIncrementSequence}"`这里面的`${autoIncrementSequence}`会增加。

前面已经提到，`KafkaScheduler`其实就是封装了一个`ScheduledThreadPoolExecutor`，`startup`的时候会重新初始化并设置：
    
    executor.setContinueExistingPeriodicTasksAfterShutdownPolicy(false)
    executor.setExecuteExistingDelayedTasksAfterShutdownPolicy(false)

### 关闭Scheduler

    shutdown()

这个方法会调用`ScheduledThreadPoolExecutor`并且等待线程都完成中止（`awaitTermination`）之后返回，因为已经设置了`shutdown`的时候立即中止已经执行的任务，所以这个方法不会阻塞太久。

### 提交调度任务

    def schedule(
        name: String,
        fun: () => Unit,
        delay: Long = 0,
        period: Long = -1,
        unit: TimeUnit = TimeUnit.MILLISECONDS)

这个方法会根据`period`的不同取值，调用`ScheduledThreadPoolExecutor`的不同方法，如果取值为负会直接等待一个延迟时间后执行：

    executor.schedule(runnable, delay, unit)

正常会启动调度：

    executor.scheduleAtFixedRate(runnable, delay, period, unit)

这个方法会打印几个关键日志，提交新的调度任务时打印：

    [DEBUG] Scheduling task ${name} with initial delay ${delay} ms and period ${period} ms.

当任务执行的时候打印：

    [INFO] Beginning execution of scheduled task '${name}'.

出现异常的时候打印：

    [ERROR] Uncaught exception in scheduled task '${name}'

完成后（无论是否有异常）：

    [INFO] Completed execution of scheduled task '${name}'.

### 调整线程池大小

    resizeThreadPool(newSize)

在使用动态用户配置（`DynamicBrokerConfig`）的时候会对线程池大小做动态调整。
