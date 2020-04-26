---
title: SocketServer
date: 2018-05-14
---

Kafka的网络层是采用多线程、多个Selector的设计实现的。

SocketServer是一个基于NIO的服务端组件，它包括：

* 一个Acceptor线程用于处理新的连接；
* Acceptor对应N个Processor线程，每个Processor线程都有自己的Selector，用于从socket里面读取请求；
* Acceptor对应M个Handler线程，用于处理请求和返回响应数据给Processor线程。

Processor线程与Handler线程之间通过RequestChannel进行通信。

下面从SocketServer的初始化过程来看它的关键属性。

## 连接的Quota控制

`SocketServer.ConnectionQuotas`维护了ClientIP到连接数的映射，用来控制每个Client端和Kafka服务端的最大连接数，下面是这个类的基本定义：

    class ConnectionQuotas(val defaultMax: Int, overrideQuotas: Map[String, Int]) {
        def inc(address: InetAddress) = address 对应计数 +1， 或 TooManyConnectionsException
        def dec(address: InetAddress) = address 对应计数 -1， 或 IllegalArgumentException
        def get(address: InetAddress) = address 对应计数， 或0
    }

初始化方法是：

    private var connectionQuotas: ConnectionQuotas = _
    ...
    this.synchronized {
        connectionQuotas = new ConnectionQuotas(
            maxConnectionsPerIp = from {{max.connections.per.ip}} default Int.MAX, 
            maxConnectionsPerIpOverrides = from {{max.connections.per.ip.overrides}} default emptyMap
        )
    }

