---
title: Network
date: 2018-05-14
---

Kafka的Client端会与服务端的Broker创建网络连接，在这些网络连接上进行着各种请求及其响应。

客户端一般情况下并发会比较小，所以使用NetworkClient组件就可以了，但是服务端有很强的高并发、低延迟的需求，所以服务端的网络层使用Reactor模式来实现。

Kafka服务端的网络组件不仅仅响应来自客户端的请求，还有来自其他Broker的连接。
