---
title: kafka-acls.sh
date: 1970-01-01
---

# kafka-acls.sh脚本

`kafka-acls.sh`是kafka权限管理（ACL的添加、删除、查询等）的命令行工具。

使用`--help`可以看到所有支持的选项。

`kafka-acls.sh`是操作[kafka.admin.AclCommand](../source/kafka-admin-acl-command)的工具脚本。

# 选项参数

调用脚本的时候如果不指定选项或使用`--help`，会打印出帮助文档：

    $ kafka-acls.sh
    This tool helps to manage acls on kafka.
    Option                                   Description
    ------                                   -----------
    --add                                    Indicates you are trying to add ACLs.
    --allow-host <String: allow-host>        Host from which principals listed in --
                                               allow-principal will have access. If
                                               you have specified --allow-principal
                                               then the default for this option
                                               will be set to * which allows access
                                               from all hosts.
    --allow-principal <String: allow-        principal is in principalType:name
      principal>                               format. Note that principalType must
                                               be supported by the Authorizer being
                                               used. For example, User:* is the
                                               wild card indicating all users.
    --authorizer <String: authorizer>        Fully qualified class name of the
                                               authorizer, defaults to kafka.
                                               security.auth.SimpleAclAuthorizer.
    ...
    --remove                                 Indicates you are trying to remove
                                               ACLs.
    ...
    --transactional-id <String:              The transactionalId to which ACLs
      transactional-id>                        should be added or removed. A value
                                               of * indicates the ACLs should apply
                                               to all transactionalIds.
    --version                                Display Kafka version.

通过`kafka.admin.AclCommand.AclCommandOptions`类的参数校验可以看到下面的规则：

* `--authorizer-properties`必须传；
* `--add / --remove / --list`必须且只传一个；
* 如果传了`--list`就不能传`--producer / --consumer / --allow-host / --allow-principal / --deny-host / --deny-principal`；
* 如果传了`--producer / --consumer`就不能有`--operation / --deny-host / --deny-principal`；
* 如果传了`--producer`就必须传`--topic`；
* 如果传了`--idempotent`就必须传`--producer`；
* 如果传了`--consumer`就必须传`--topic / --group / `；
* 如果传了`--consumer`没传`--producer`就不能传`--cluster / --transactional-id`；

# 查询ACL列表

    // Use AuthorizerService / --authorizer-properties
    $ kafka-acls.sh --list --authorizer-properties zookeeper.connect=zookeeper:2181

    // 这部分是原作者在测试过程中碰到问题，等待测试补充
    // Use AdminClientService / --bootstrap-server
    $ kafka-acls.sh --list --bootstrap-server kafka:9092
    Error while executing ACL command: org.apache.kafka.common.errors.SecurityDisabledException: No Authorizer is configured on the broker
    java.util.concurrent.ExecutionException: org.apache.kafka.common.errors.SecurityDisabledException: No Authorizer is configured on the broker
        at org.apache.kafka.common.internals.KafkaFutureImpl.wrapAndThrow(KafkaFutureImpl.java:45)
        at org.apache.kafka.common.internals.KafkaFutureImpl.access$000(KafkaFutureImpl.java:32)
        at org.apache.kafka.common.internals.KafkaFutureImpl$SingleWaiter.await(KafkaFutureImpl.java:89)
        at org.apache.kafka.common.internals.KafkaFutureImpl.get(KafkaFutureImpl.java:260)
        at kafka.admin.AclCommand$AdminClientService.getAcls(AclCommand.scala:171)
        at kafka.admin.AclCommand$AdminClientService.$anonfun$listAcls$1(AclCommand.scala:134)
        at kafka.admin.AclCommand$AdminClientService.$anonfun$listAcls$1$adapted(AclCommand.scala:131)
        at kafka.admin.AclCommand$AdminClientService.withAdminClient(AclCommand.scala:92)
        at kafka.admin.AclCommand$AdminClientService.listAcls(AclCommand.scala:131)
        at kafka.admin.AclCommand$.main(AclCommand.scala:66)
        at kafka.admin.AclCommand.main(AclCommand.scala)
    Caused by: org.apache.kafka.common.errors.SecurityDisabledException: No Authorizer is configured on the broker

# 添加ACL项

    // authorize(request.session, Alter, Resource.ClusterResource)
    // The principal type is always User for the simple authorizer
    $ kafka-acls.sh \
        --authorizer-properties zookeeper.connect=zookeeper:2181 \
        --add \
        --cluster \
        --operation Alter \
        --deny-principal User:ANONYMOUS
    Adding ACLs for resource `Cluster:LITERAL:kafka-cluster`:
        User:ANONYMOUS has Deny permission for operations: Alter from hosts: *

    Current ACLs for resource `Cluster:LITERAL:kafka-cluster`:
        User:ANONYMOUS has Deny permission for operations: Alter from hosts: *

    $ kafka-acls.sh \
        --authorizer-properties zookeeper.connect=zookeeper:2181 \
        --list
    Current ACLs for resource `Cluster:LITERAL:kafka-cluster`:
        User:ANONYMOUS has Deny permission for operations: Alter from hosts: *
    // With authorizer.class.name=kafka.security.auth.SimpleAclAuthorizer
    $ kafka-acls.sh \
        --bootstrap-server kafka:9092 \
        --list
