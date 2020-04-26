---
title: KafkaController
date: 2018-05-21
state: inprogress
---

`kafka.controller.KafkaController`是`KafkaServer`处理外界请求的控制器，这些请求包括来自客户端的请求，也包括来自其它broker的请求。

在集群的所有broker里，有一个会被选举为leader，管理集群所有的partition和副本状态，包括partition的leader选举等。

其中很多操作都依靠zookeeper来完成，先来看一下整体结构：

    /controller         => 保存JSON串 { version: 0, brokerid: 0, timestamp: 1 }
    /controller_epoch   => 保存数字 epoch

::: tip
kafka里面有两个地方是主从结构：第一个就是本文介绍的`KafkaController`，由Master负责整个集群的管理，第二个是Replica，由Master负责响应外界请求，并更新到从节点。两者需要区分清楚。
:::

## KafkaController启动过程

在构造的时候，`KafkaController`除了初始化了一系列handler和manager，没有做什么实际的工作，当`startup`被调用的时候，会发送`RegisterBrokerAndReelect`到事件管理器，之后每次zk session变化的时候，都依次发送`Expire`和`RegisterBrokerAndReelect`事件：

    private val eventManager = new ControllerEventManager(config.brokerId, [metrics related params])
    def startup() = {
        zkClient.registerStateChangeHandler(new StateChangeHandler {
            override val name: String = StateChangeHandlers.ControllerHandler
            override def afterInitializingSession(): Unit = {
                eventManager.put(RegisterBrokerAndReelect)
            }
            override def beforeInitializingSession(): Unit = {
                val expireEvent = new Expire
                eventManager.clearAndPut(expireEvent)
                expireEvent.waitUntilProcessed()
            }
        })
        eventManager.put(Startup)
        eventManager.start()
    }

[eventManager](kafka-controller-controller-event-manager)通过一个内存队列来异步执行`put`方法写入的事件，而`StateChangeHandler`是`kafka`自己定义的回调，当注册在`kafka`上的`Watcher`被触发且状态是`KeeperState.Expired`的时候触发，依次执行`beforeInitializingSession -> 重新初始化ZK连接 -> afterInitializingSession`。

## 领导选举

`KafkaController.elect`方法定义了领导选举的过程，完全依赖`Zookeeper`，所谓领导选举，其实是领导抢占，所有broker会竞相向`/controller`写入自己的信息，谁写入成功了，谁就是leader。

    private def elect(): Unit = {
        val timestamp = time.milliseconds
        // 从 /controller 节点读取leader的 controllerId
        activeControllerId = zkClient.getControllerId.getOrElse(-1)

        // 在某些竞争条件下，例如启动和响应ZK节点删除同时发生，代码运行到这儿可能leader已经产生了
        // 如果新 leader 就是自己，后面调用checkedEphemeralCreate不会失败，进而进入死循环
        // 所以一旦发现leader已经产生，就停止选举过程。
        if (activeControllerId != -1) {
            return
        }

        try {
            zkClient.checkedEphemeralCreate(ControllerZNode.path, ControllerZNode.encode(config.brokerId, timestamp))
            activeControllerId = config.brokerId   // 不报错即为选举成功
            onControllerFailover()
        } catch {
            case _: NodeExistsException =>
                // 其它节点已经成为leader
                activeControllerId = zkClient.getControllerId.getOrElse(-1)
            case e2: Throwable =>
                triggerControllerMove()
        }
    }

`onControllerFailover`在自己通过`elect`方法成为leader之后被调用，意为Controller故障转移完成，整个过程分为：

1. 读取zk`/controller_epoch`节点的数据，获取当前controller的年代（epoch）信息和zk节点版本；
2. 把年代信息+1并写回zk，仅当zk节点版本没有变化的时候写入成功，确保zk在读和写之间没有更新，如果有了更新，说明已经有其他节点成为新的leader并更新了controller年代，这时候抛出`ControllerMovedException`；
3. 初始化管理当前topics、brokers和partitions的zk监听：
    * `brokerChangeHandler` - 当`/brokers/ids/`的子节点变化时，发送 `BrokerChange` 事件；
    * `topicChangeHandler` - 当`/brokers/topics/`的子节点变化时，发送 `TopicChange` 事件；
    * `topicDeletionHandler` - 当`/admin/delete_topics/`的子节点变化时，发送 `TopicDeletion` 事件；
    * `logDirEventNotificationHandler` - 当`/log_dir_event_notification/`的子节点变化时，发送 `LogDirEventNotification` 事件；
    * `isrChangeNotificationHandler` - 当`/isr_change_notification/`的子节点变化时，发送 `IsrChangeNotification` 事件； 
    * `preferredReplicaElectionHandler` - 当`/admin/preferred_replica_election`节点创建时，发送 `PreferredReplicaLeaderElection` 事件；
    * `partitionReassignmentHandler` - 当`/admin/reassign_partitions`节点创建时，发送 `PartitionReassignment` 事件；
    * `deleteLogDirEventNotifications` - 删除`/log_dir_event_notification/log_dir_event_${sequence}`所有节点；
    * `deleteIsrChangeNotifications` - 删除`/isr_change_notification/isr_change_${sequence}`所有节点；
4. 启动channel manager；
5. 启动复制管理的状态机；
6. 启动分区管理的状态机；

If it encounters any unexpected exception/error while becoming controller, it resigns as the current controller.
This ensures another controller election will be triggered and there will always be an actively serving controller

    private def onControllerFailover() {
        // 1. 读取zk上的controller年代信息
        readControllerEpochFromZooKeeper()     
        // 2. 增加年代信息并写回zk
        incrementControllerEpoch()

        // 3. 初始化一系列zk监听
        val childChangeHandlers = Seq(
            brokerChangeHandler, topicChangeHandler, topicDeletionHandler, 
            logDirEventNotificationHandler, isrChangeNotificationHandler)
        childChangeHandlers.foreach(zkClient.registerZNodeChildChangeHandler)
        val nodeChangeHandlers = Seq(
            preferredReplicaElectionHandler, 
            partitionReassignmentHandler)
        nodeChangeHandlers.foreach(zkClient.registerZNodeChangeHandlerAndCheckExistence)

        zkClient.deleteLogDirEventNotifications()
        zkClient.deleteIsrChangeNotifications()
        // 初始化 ControllerContext 后面详解
        initializeControllerContext()
        // 处理还没有删除完成的topic
        val (topicsToBeDeleted, topicsIneligibleForDeletion) = fetchTopicDeletionsInProgress()
        topicDeletionManager.init(topicsToBeDeleted, topicsIneligibleForDeletion)

        // 需要在controller context初始化之后、状态机启动之前发送UpdateMetadataRequest，
        // 因为各个broker节点需要先从中解析出存活的broker列表，才能处理 replicaStateMachine.startup()
        // 和 partitionStateMachine.startup() 过程中发出的 LeaderAndIsrRequests
        sendUpdateMetadataRequest(controllerContext.liveOrShuttingDownBrokerIds.toSeq)

        replicaStateMachine.startup()
        partitionStateMachine.startup()

        maybeTriggerPartitionReassignment(controllerContext.partitionsBeingReassigned.keySet)
        topicDeletionManager.tryTopicDeletion()
        val pendingPreferredReplicaElections = fetchPendingPreferredReplicaElections()
        onPreferredReplicaElection(pendingPreferredReplicaElections)
    
        kafkaScheduler.startup()
        if (config.autoLeaderRebalanceEnable) {
            scheduleAutoLeaderRebalanceTask(delay = 5, unit = TimeUnit.SECONDS)
        }

        if (config.tokenAuthEnabled) {
            tokenCleanScheduler.startup()
            tokenCleanScheduler.schedule(name = "delete-expired-tokens",
                fun = tokenManager.expireTokens,
                period = config.delegationTokenExpiryCheckIntervalMs,
                unit = TimeUnit.MILLISECONDS)
        }
    }

## Controller事件

### Reelect

重新选举的过程如下：

1. 先记录自己是不是本代的leader（`activeControllerId`是不是自己，这里只是用的内存中的状态，没有拉取最新）；
2. 注册对`/controller`节点的监听（`controllerChangeHandler`）:
    * 节点创建或数据被修改的时候，发送`ControllerChange`事件到事件管理器；
    * 节点被删除的时候，发送`Reelect`事件到事件管理器；
3. 从ZK更新当前的leader是谁，如果之前内存中记录的leader是自己，更新之后不是了，调用`onControllerResignation`来进行一系列的清理操作：
    * 不再监听`/isr_change_notification`子节点变化；
    * 不再监听`/admin/reassign_partitions`内容变化；
    * 不再监听`/admin/preferred_replica_election`内容变化；
    * 不再监听`/log_dir_event_notification`子节点变化；
    * 不再监听`/brokers/ids/${id}`所有其他broker信息的变化；


    def isActive: Boolean = activeControllerId == config.brokerId

    case object Reelect extends ControllerEvent {
        override def state = ControllerState.ControllerChange

        override def process(): Unit = {
            val wasActiveBeforeChange = isActive
            zkClient.registerZNodeChangeHandlerAndCheckExistence(controllerChangeHandler)
            activeControllerId = zkClient.getControllerId.getOrElse(-1)
            if (wasActiveBeforeChange && !isActive) {
                onControllerResignation()
            }
            elect()
        }
    }

### RegisterBrokerAndReelect

和领导选举相关的事件有两个： `Reelect`和`RegisterBrokerAndReelect`。

在`startup`的时候，会产生`RegisterBrokerAndReelect`事件：

    case object RegisterBrokerAndReelect extends ControllerEvent {
        override def state: ControllerState = ControllerState.ControllerChange

        override def process(): Unit = {
            zkClient.registerBrokerInZk(brokerInfo)
            Reelect.process()
        }
    }

从`process`中可以看出，`RegisterBrokerAndReelect`总共做了两件事，第一是把自己的broker信息写入临时节点`/brokers/ids/${brokerId}`，然后进入`Reelect`事件的处理过程。
