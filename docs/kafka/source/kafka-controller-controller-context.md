---
title: ControllerContext
date: 2018-05-28
state: inprogress
---

## Context的定义

`kafka.controller.ControllerContext`维护了`KafkaController`的上下文信息。

    class ControllerContext {
        // 统计信息，为每一个 ControllerState 维护了 Timer
        val stats = new ControllerStats
        var controllerChannelManager: ControllerChannelManager = null
        ...
    }

### Controller的年代

当前Controller Leader会把年代信息存储在`/controller_epoch`zk节点上，对应的值和zk版本存储在：

    // 两个 InitialXXX 都等于 1
    var epoch: Int = KafkaController.InitialControllerEpoch - 1
    var epochZkVersion: Int = KafkaController.InitialControllerEpochZkVersion - 1

### 集群中的Broker

维护了集群中所有存活的Broker集合和对应的Id集合。

    private var liveBrokersUnderlying: Set[Broker] = Set.empty
    private var liveBrokerIdsUnderlying: Set[Int] = Set.empty
    var shuttingDownBrokerIds: mutable.Set[Int] = mutable.Set.empty // 包括在 liveBroker... 里面

赋值写入的方法简单粗暴：

    def liveBrokers_=(brokers: Set[Broker]) {
        liveBrokersUnderlying = brokers
        liveBrokerIdsUnderlying = liveBrokersUnderlying.map(_.id)
    }

读取的方法需要去掉正在关闭的Broker。

    def liveBrokers = liveBrokersUnderlying.filter(broker => !shuttingDownBrokerIds.contains(broker.id))
    def liveBrokerIds = liveBrokerIdsUnderlying -- shuttingDownBrokerIds

    def liveOrShuttingDownBrokerIds = liveBrokerIdsUnderlying
    def liveOrShuttingDownBrokers = liveBrokersUnderlying

### 分区及副本状态

有三个和副本相关的数据结构：

    // 所有partition以及存储该partition的所有机器的brokerId，
    // 如 partition0 -> [broker1, broker3, broker6]
    var partitionReplicaAssignment: mutable.Map[TopicPartition, Seq[Int]] = mutable.Map.empty
    // 所有partition以及partition的主从关系，
    // 如 partition0 -> (partitionLeader(id, epoch, zkversion), isr, controllerLeader(id, epoch))
    var partitionLeadershipInfo: mutable.Map[TopicPartition, LeaderIsrAndControllerEpoch] = mutable.Map.empty
    // 所有partition和等待重新分配主从关系的上下文，
    // 如 partition0 -> (newReplicas, changeHandler(/brokers/topics/$topic/partitions/$partition/state))
    val partitionsBeingReassigned: mutable.Map[TopicPartition, ReassignedPartitionsContext] = mutable.Map.empty

根据Broker获取Broker上存储的分区，这两个方法的名字不同，返回值也不同，但逻辑是一样的，不管查询的Broker是分区的Leader还是Follower，只要存了对应分区的数据，就会返回对应的信息：

    def partitionsOnBroker(brokerId: Int): Set[TopicPartition] = {
        partitionReplicaAssignment.collect {
            case (topicPartition, replicas) if replicas.contains(brokerId) => topicPartition
        }.toSet
    }

    def replicasOnBrokers(brokerIds: Set[Int]): Set[PartitionAndReplica] = {
        brokerIds.flatMap { brokerId =>
            partitionReplicaAssignment.collect { case (topicPartition, replicas) if replicas.contains(brokerId) =>
                PartitionAndReplica(topicPartition, brokerId)
            }
        }.toSet
    }

根据Topic获取对应的分区，以及所有的副本：

    def partitionsForTopic(topic: String): collection.Set[TopicPartition] =
        partitionReplicaAssignment.keySet.filter(topicPartition => topicPartition.topic == topic)

    def replicasForTopic(topic: String): Set[PartitionAndReplica] = {
        partitionReplicaAssignment
            .filter { case (topicPartition, _) => topicPartition.topic == topic }
            .flatMap { case (topicPartition, replicas) =>
                replicas.map(PartitionAndReplica(topicPartition, _))
            }.toSet
    }

根据Partition查询所有副本：

    def replicasForPartition(partitions: collection.Set[TopicPartition]): collection.Set[PartitionAndReplica] = {
        partitions.flatMap { p =>
            val replicas = partitionReplicaAssignment(p)
            replicas.map(PartitionAndReplica(p, _))
        }
    }

判断副本是否在线和获取所有在线的副本，默认情况下，正在Shutdown的认为不在线：

    val replicasOnOfflineDirs: mutable.Map[Int, Set[TopicPartition]] = mutable.Map.empty

    def isReplicaOnline(brokerId: Int, topicPartition: TopicPartition, includeShuttingDownBrokers: Boolean = false): Boolean = {
        val brokerOnline = {
            if (includeShuttingDownBrokers) liveOrShuttingDownBrokerIds.contains(brokerId)
            else liveBrokerIds.contains(brokerId)
        }
        brokerOnline && !replicasOnOfflineDirs.getOrElse(brokerId, Set.empty).contains(topicPartition)
    }

    def allLiveReplicas(): Set[PartitionAndReplica] = {
        replicasOnBrokers(liveBrokerIds).filter { partitionAndReplica =>
            isReplicaOnline(partitionAndReplica.replica, partitionAndReplica.topicPartition)
        }
    }

### Topic的管理

保存集群中所有的topic以及对应的删除方法：
    
    var allTopics: Set[String] = Set.empty

    def removeTopic(topic: String) = {
        partitionLeadershipInfo = partitionLeadershipInfo.filter { case (topicPartition, _) => topicPartition.topic != topic }
        partitionReplicaAssignment = partitionReplicaAssignment.filter { case (topicPartition, _) => topicPartition.topic != topic }
        allTopics -= topic
    }
