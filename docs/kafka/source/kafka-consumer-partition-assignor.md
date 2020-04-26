---
title: Kafka源码之PartitionAssignor
date: 2018-07-04
---

::: tip
代码来自 kafka-1.1.0
:::

## 用法

`PartitionAssignor`用来为consumer线程（特别注意，这里是consumer线程而不是consumer实例）分配它应该消费的partition，在`0.11.0.0`之前，位于`kafka.consumer`包内，`0.11.0.0`之后，使用位于`org.apache.kafka.clients.consumer.internals`包内的定义。

先来看老版本的接口定义：

    trait PartitionAssignor {
        def assign(ctx: AssignmentContext): Pool[String, mutable.Map[TopicAndPartition, ConsumerThreadId]]
    }
    object PartitionAssignor {
        def createInstance(assignmentStrategy: String) = assignmentStrategy match {
            case "roundrobin" => new RoundRobinAssignor()
            case _ => new RangeAssignor()
        }
    }

`PartitionAssignor.createInstance`在`ZookeeperConsumerConnector`中被使用，根据配置`partition.assignment.strategy`的值选择对应的Assignor，默认取值为`range`。

这两种Assignor各是什么分配逻辑呢，`RangeAssignor`就是把每个topic的`<partition>`排好序，按数量分为多组并分配给消费线程，假设现在有两个消费实例C1和C2，每个实例启动两个线程，一共4个消费线程C1-0、C1-1、C2-0、C2-1，topic1有6个partition，分别标记为t1p0-t1p5，那么首先计算出前两个消费线程应该各消费两个partition，后两个消费线程各消费1个partition，然后把partition按顺序分组，得到：




## 源码

`Pool`是kafka自己定义的数据结构，可以理解为是一个Map，传入一个上下文，返回

    Map(topic -> Map(partition -> thread))

参数`AssignmentContext`顾名思义是专门为分配partition设计的数据结构：

    class AssignmentContext(group: String, val consumerId: String, excludeInternalTopics: Boolean, zkUtils: ZkUtils) {
        val myTopicThreadIds: collection.Map[String, collection.Set[ConsumerThreadId]] = {
            val myTopicCount = TopicCount.constructTopicCount(group, consumerId, zkUtils, excludeInternalTopics)
            myTopicCount.getConsumerThreadIdsPerTopic
        }

        val consumersForTopic: collection.Map[String, List[ConsumerThreadId]] =
            zkUtils.getConsumersPerTopic(group, excludeInternalTopics)

        // Some assignment strategies require knowledge of all topics consumed by any member of the group
        val partitionsForTopic: collection.Map[String, Seq[Int]] =
            zkUtils.getPartitionsForTopics(consumersForTopic.keySet.toSeq)

        val consumers: Seq[String] = zkUtils.getConsumersInGroup(group).sorted
    }
