---
title: Kafka
date: 2018-03-28
---

## Kafka

断断续续，看过0.8.x，0.11.x的源码；

最后整理的这份，主要来自1.1.0的版本，发布于2018年3月28号。

后来的文档整理参考了 [kafka-notebook](https://jaceklaskowski.gitbooks.io/apache-kafka/)

代码说明：贴源码的地方一般都是伪代码，包括：

* 常量替换为具体值；
* 参数会替换为`name = param`的形式；
* logger代码一般会删掉；
* 统计打点类的代码会在metrics模块单独说明，不在代码里面体现；
* 部分不影响主逻辑理解的异常处理

PS：
* `AbstractIndex`是个比较好的学习`MappedByteBuffer`的例子。
