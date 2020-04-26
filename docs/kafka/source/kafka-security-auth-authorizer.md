---
title: 权限控制
date: 1970-01-01
state: COMPLETED
---

## Authorizer

`kafka.security.auth.Authorizer`是Kafka服务端对基于ACL的客户端操作的身份认证接口。

ACL（`access-control list`）是一个权限列表，每一个列表项都是一个目标对象和对应的权限。

Kafka服务端启动的时候，通过`authorizer.class.name`配置项来指定`Authorizer`，默认为空：

    // 定义在kafka.server.KafkaConfig，变量替换为具体值
    new ConfigDef().define(
        name          = "authorizer.class.name", 
        type          = STRING, 
        defaultValue  = "", 
        importance    = LOW, 
        documentation = "The authorizer class that should be used for authorization")

`KafkaServer`会根据上述配置初始化一个`Option[Authorizer]`，如果取值为空，所有操作都被允许：

    authorizer = Option(config.authorizerClassName).filter(_.nonEmpty).map { authorizerClassName =>
        val authZ = CoreUtils.createObject[Authorizer](authorizerClassName)
        authZ.configure(config.originals())
        authZ
    }

::: tip
本篇主要介绍`kafka 1.1.0`的实现，到了`kafka 2.4.0`又做了[升级](https://cwiki.apache.org/confluence/display/KAFKA/KIP-504+-+Add+new+Java+Authorizer+Interface)
:::

下面具体来看`Authorizer`的接口定义：

    public interface Configurable {
        void configure(Map<String, ?> configs);
    }

    trait Authorizer extends Configurable {
      def authorize(session: Session, operation: Operation, resource: Resource): Boolean
      def addAcls(acls: Set[Acl], resource: Resource): Unit
      def removeAcls(acls: Set[Acl], resource: Resource): Boolean
      def removeAcls(resource: Resource): Boolean
      def getAcls(resource: Resource): Set[Acl]
      def getAcls(principal: KafkaPrincipal): Map[Resource, Set[Acl]]
      def getAcls(): Map[Resource, Set[Acl]]
      def close(): Unit
    }

参数比较直观，不展开介绍。在被初始化之后需要调用`configure`方法，并在每个客户端请求到来的时候调用`authorize`来进行认证。

### Operation

认证的内容包括资源和操作，操作定义在`kafka.security.auth.Opertion`，后来逐步迁移到`clients`包下面的`org.apache.kafka.common.acl.AclOperation`，这里直接展示`AclOperation`的定义：

    public enum AclOperation {
        UNKNOWN((byte) 0),           // Java版新引入，兼容老客户端
        ANY((byte) 1),               // Java版新引入
        ALL((byte) 2),               // 对应于Scala版的 Operation.All
        READ((byte) 3),              // 对应于Scala版的 Operation.Read
        WRITE((byte) 4),             // 对应于Scala版的 Operation.Write
        CREATE((byte) 5),            // 对应于Scala版的 Operation.Create
        DELETE((byte) 6),            // 对应于Scala版的 Operation.Delete
        ALTER((byte) 7),             // 对应于Scala版的 Operation.Alter
        DESCRIBE((byte) 8),          // 对应于Scala版的 Operation.Describe
        CLUSTER_ACTION((byte) 9),    // 对应于Scala版的 Operation.ClusterAction
        DESCRIBE_CONFIGS((byte) 10), // 对应于Scala版的 Operation.DescribeConfigs
        ALTER_CONFIGS((byte) 11),    // 对应于Scala版的 Operation.AlterConfigs
        IDEMPOTENT_WRITE((byte) 12); // 对应于Scala版的 Operation.IdempotentWrite
    }

### Resource

认证的内容包括资源和操作，资源包括资源类型和资源名两部分：

    case class Resource(resourceType: ResourceType, name: String) {
        override def toString: String = resourceType.name + Resource.Separator + name
    }

例如要描述`test`这个Topic，对应的`Resource`就是`Topic:test`，要描述`ggg`这个消费组，对应的`Resource`就是`Group:ggg`。

资源类型（`ResourceType`）也是原本定义在`kafka.security.auth.ResourceType`，后来逐步迁移到Java版`clients`包下面的`org.apache.kafka.common.resource.ResourceType`，这里直接展示Java版的定义：

    public enum ResourceType {
        UNKNOWN((byte) 0),           // Java版新引入，兼容老客户端
        ANY((byte) 1),               // Java版新引入
        TOPIC((byte) 2),             // 对应于Scala版的 ResourceType.Topic，kafka的topic
        GROUP((byte) 3),             // 对应于Scala版的 ResourceType.Group，consumer group
        CLUSTER((byte) 4),           // 对应于Scala版的 ResourceType.Cluster
        TRANSACTIONAL_ID((byte) 5),  // 对应于Scala版的 ResourceType.TransactionalId
        DELEGATION_TOKEN((byte) 6);  // 对应于Scala版的 ResourceType.DelegationToken，表示token id
    }

### PermissionType

所有ACL项都有一个类型，操作定义在`kafka.security.auth.PermissionType`，后来逐步迁移到`clients`包下面的`org.apache.kafka.common.acl.AclPermissionType`，这里直接展示`AclPermissionType`的定义：

    public enum AclPermissionType {
        UNKNOWN((byte) 0),           // Java版新引入，兼容老客户端
        ANY((byte) 1),               // Java版新引入
        DENY((byte) 2),              // 对应于Scala版的 PermissionType.Deny
        ALLOW((byte) 3),             // 对应于Scala版的 PermissionType.Allow
    }

## SimpleAclAuthorizer

`kafka.security.auth.SimpleAclAuthorizer`是`Authorizer`的唯一实现，它借助Zookeeper来存储权限信息。

### configure

在`configure`方法中对Authorizer来进行初始化。

1） 首先从配置文件中加载超级用户：

    // val SuperUsersProp = "super.users"
    superUsers = configs.get(SimpleAclAuthorizer.SuperUsersProp).collect {
      case str: String if str.nonEmpty => str.split(";").map(s => SecurityUtils.parseKafkaPrincipal(s.trim)).toSet
    }.getOrElse(Set.empty[KafkaPrincipal])

`KafkaPrincipal`是`<principalType, name>`元组，例如`super.users = User:zhangsan`。

2） 然后加载当没有设置ACL时的通用策略，是否允许所有Client访问：

    // 变量替换为具体值
    shouldAllowEveryoneIfNoAclIsFound = configs.get("allow.everyone.if.no.acl.found").exists(_.toString.toBoolean)

3） 初始化Zookeeper连接和节点

    // Zookeeper Client，pseudo-code
    zkClient = KafkaZkClient(
        connectString = configs.get("authorizer.zookeeper.url") orElse 
                        configs.get("kafkaConfig.zkConnect"), 
        isSecure = configs.get("zookeeper.set.acl"), 
        sessionTimeoutMs = configs.get("authorizer.zookeeper.session.timeout.ms") orElse 
                           configs.get("zookeeper.session.timeout.ms"),
        connectionTimeoutMs = configs.get("authorizer.zookeeper.connection.timeout.ms") orElse 
                              configs.get("zookeeper.connection.timeout.ms") orElse 
                              configs.get("zookeeper.session.timeout.ms"),
        maxInFlightRequests = configs.get("authorizer.zookeeper.max.in.flight.requests" orElse 
                              configs.get("zookeeper.max.in.flight.requests"), 
        time = time, 
        metricGroup = "kafka.security", 
        metricType = "SimpleAclAuthorizer")
    zkClient.createAclPaths()

最后的语句会创建ACL功能依赖的ZK路径：

* `/kafka-acl-changes`
* `/kafka-acl/${resourceType}`

如果为zhangsan赋予test这个topic的读写权限，那么在`/kafka-acl/Topic/test`节点下面会写入：

    {
        "version": 1,
        "acls": [{
            "principal": "User:zhangsan",
            "permissionType": "Allow",
            "operation": "Read",
            "host": "*"
        }, {
            "principal": "User:zhangsan",
            "permissionType": "Allow",
            "operation": "Write",
            "host": "*"
        }]
    }

每个条目都与`kafka.security,auth.Acl`对应：

    case class Acl(principal: KafkaPrincipal, permissionType: PermissionType, host: String, operation: Operation)

4） 把ZK数据加载进内存：

    private val aclCache = new scala.collection.mutable.HashMap[Resource, VersionedAcls]
    ...
    private def loadCache()  {
        inWriteLock(lock) {
            val resourceTypes = zkClient.getResourceTypes()
            for (rType <- resourceTypes) {
                val resourceType = ResourceType.fromString(rType)
                val resourceNames = zkClient.getResourceNames(resourceType.name)
                for (resourceName <- resourceNames) {
                    val versionedAcls = getAclsFromZk(Resource(resourceType, resourceName))
                    updateCache(new Resource(resourceType, resourceName), versionedAcls)
                }
            }
        }
    }
    private def updateCache(resource: Resource, versionedAcls: VersionedAcls) {
        if (versionedAcls.acls.nonEmpty) {
            aclCache.put(resource, versionedAcls)
        } else {
            aclCache.remove(resource)
        }
    }

这样就把诸如前面`/kafka-acl/Topic/test`的所有数据加载到`aclCache`里面，`VersionedAcls`就是对应于前面JSON的数据结构，这里不展开。

5） 初始化对`/kafka-acl-changes`节点的监听：

    aclChangeListener = new ZkNodeChangeNotificationListener(zkClient, 
        seqNodeRoot = "/kafka-acl-changes", 
        seqNodePrefix = "acl_changes_", 
        AclChangedNotificationHandler)
    aclChangeListener.init()

    ...
    object AclChangedNotificationHandler extends NotificationHandler {
        override def processNotification(notificationMessage: Array[Byte]) {
            val resource: Resource = Resource.fromString(new String(notificationMessage, StandardCharsets.UTF_8))
            inWriteLock(lock) {
                val versionedAcls = getAclsFromZk(resource)
                updateCache(resource, versionedAcls)
            }
        }
    }

当ZK的`/kafka-acl-changes/acl_changes_*`有新增，会从ZK节点中解析`Topic:test`之类的资源串，然后从`/kafka-acl/Topic/test`读取数据并加载到缓存。`ZkNodeChangeNotificationListener`默认会删除超过15分钟的节点。

### authorize

当服务端接收到请求之后，会调用`authorize`验证权限。这是一个纯内存`aclCache`的匹配。

    override def authorize(session: Session, operation: Operation, resource: Resource): Boolean = {
        // 客户端配置的username
        val principal = session.principal
        val host = session.clientAddress.getHostAddress
        // 获取指定资源类型下所有指定名称和通配符"*"的所有规则
        val acls = getAcls(resource) ++ getAcls(new Resource(resource.resourceType, "*"))

        // 检查是否有Deny类型的规则
        val denyMatch = aclMatch(operation, resource, principal, host, Deny, acls)

        // 检查是否有Allow类型的规则，有读写删改权限的话会自动赋予描述权限
        val allowOps = operation match {
          case Describe => Set[Operation](Describe, Read, Write, Delete, Alter)
          case DescribeConfigs => Set[Operation](DescribeConfigs, AlterConfigs)
          case _ => Set[Operation](operation)
        }
        val allowMatch = allowOps.exists(operation => aclMatch(operation, resource, principal, host, Allow, acls))

        val authorized = isSuperUser(operation, resource, principal, host) ||
          isEmptyAclAndAuthorized(operation, resource, principal, host, acls) ||
          (!denyMatch && allowMatch)

        logAuditMessage(principal, authorized, operation, resource, host)
        authorized
    }

从最后`authorized`的计算方式可以看出匹配规则：

* 当客户端用户是超级用户时直接放行；
* 当没有配置ACL，并且设置了没有ACL时对所有用户公开；
* 没有命中Deny类型的规则，且命中Allow规则。

`aclMatch`的规则是：

    private def aclMatch(operations: Operation, resource: Resource, principal: KafkaPrincipal, host: String, permissionType: PermissionType, acls: Set[Acl]): Boolean = {
        acls.find { acl =>
          acl.permissionType == permissionType &&
            (acl.principal == principal || acl.principal == Acl.WildCardPrincipal) &&
            (operations == acl.operation || acl.operation == All) &&
            (acl.host == host || acl.host == Acl.WildCardHost)
        }.exists { acl =>
          authorizerLogger.debug(s"operation = $operations on resource = $resource from host = $host is $permissionType based on acl = $acl")
          true
        }
    }

* ACL项的permissionType与预期相等（Allow / Deny）；
* ACL项的principal与预期相等或等于通配符`*`（principal对应`User:zhangsan等`）；
* ACL项的operation与预期相等或等于通配符`*`（operation对应`Read`、`Write`等）；
* ACL项的host与客户端host相等或等于通配符`*`；

## 我的疑问

所有的增删操作都是先修改ZK的`/kafka-acls/${resourceType}/xxx`然后再向`/kafka-acl-changes/acl_changes_*`追加节点通知其它broker，这两步中间挂了怎么办？
