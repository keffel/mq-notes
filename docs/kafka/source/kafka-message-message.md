---
title: Message消息结构
date: 2018-06-22
---

## Messages概念

Messages是broker存储partition数据的结构，它按顺序存储在partition日志文件的最后，用唯一的`offsets`来标识。数据是存储在磁盘上，并且在集群中存储多份拷贝，防止数据丢失，并且在内存中维护一个cache来加速数据读取。

## Message数据结构

`kafka.message.Message`定义了消息体的数据结构：

| 内容 | 长度 | 说明 |
|---|---|---|
| CRC32 | 4 bytes | 可以认为是一个消息的版本号，或许叫version更合适 |
| magic | 1 bytes | |
| attributes | 1 bytes | 属性集合 |
| timestamp | 8 bytes, optional | magic==0的时候没有这个字段 |
| key length | 4 bytes, KL | |
| key | KL bytes | |
| payload length | 4 bytes, PL | |
| payload | PL bytes | |

attributes的结构如下：

    reversed (4 bits) | Timestamp type (1 bit) | Compression codec (3 bit)

高4位保留，然后是一位的时间戳类型，两种取值：0表示创建时间，1表示日志添加时间，最后的低3位是压缩的方法，取值为：

- 0 : no compression
- 1 : gzip
- 2 : snappy
- 3 : lz4


