---
title: AclCommand
date: 1970-01-01
---

`AclCommand`是一个用于管理ACL的工具类，位于`core`模块的`kafka.admin`包下面，可以通过[kafka-acls.sh](../usage/kafka-acls)脚本来调用。

内部类`AclCommandOptions`定义了选项列表，可以参照[kafka-acls.sh](../usage/kafka-acls)中的选项描述。

`--add`/`--remove`/`--list`是必须的三个选项，且只能设置一个，在`main`入口方法里面，根据是哪个选项来调用不同逻辑：

    def main(args: Array[String]) {
        ...
        if (opts.options.has(opts.addOpt))
            addAcl(opts)
        else if (opts.options.has(opts.removeOpt))
            removeAcl(opts)
        else if (opts.options.has(opts.listOpt))
            listAcl(opts)
        }
        ...
    }
    
    private def addAcl(opts: AclCommandOptions) {
        withAuthorizer(opts) { authorizer => ...}
    }
    
    private def removeAcl(opts: AclCommandOptions) {
        withAuthorizer(opts) { authorizer => ...}
    }
    
    private def listAcl(opts: AclCommandOptions) {
        withAuthorizer(opts) { authorizer => ...}
    }

# withAuthorizer

通过上面的`main`方法内容可以看到，所有操作都被`withAuthorizer`方法包装，

    def withAuthorizer(opts: AclCommandOptions)(f: Authorizer => Unit) {
        val defaultProps = Map("zookeeper.set.acl" -> JaasUtils.isZkSecurityEnabled)
        val authorizerProperties = [pseudo-code] parseArg("authorizer-properties") ++ defaultProps

        val authZ = [pseudo-code] CoreUtils.createObject[Authorizer](parseArg("authorizer"))
        try {
            authZ.configure(authorizerProperties.asJava)
            f(authZ)
        }
        finally CoreUtils.swallow(authZ.close(), this)
    } 

关键在于`authorizer`选项指定的`Authorizer`类，默认为[kafka.security.auth.SimpleAclAuthorizer](./kafka-security-auth-authorizer#SimpleAclAuthorizer)


def withAuthorizer(opts: AclCommandOptions)(f: Authorizer => Unit) {
    val defaultProps = Map(KafkaConfig.ZkEnableSecureAclsProp -> JaasUtils.isZkSecurityEnabled)
    val authorizerProperties =
      if (opts.options.has(opts.authorizerPropertiesOpt)) {
        val authorizerProperties = opts.options.valuesOf(opts.authorizerPropertiesOpt).asScala
        defaultProps ++ CommandLineUtils.parseKeyValueArgs(authorizerProperties, acceptMissingValue = false).asScala
      } else {
        defaultProps
      }

    val authorizerClass = opts.options.valueOf(opts.authorizerOpt)
    val authZ = CoreUtils.createObject[Authorizer](authorizerClass)
    try {
      authZ.configure(authorizerProperties.asJava)
      f(authZ)
    }
    finally CoreUtils.swallow(authZ.close(), this)
  }

AclCommand uses AdminClientService (when executed with --bootstrap-server option) or AuthorizerService.
kafka-acls.sh requires Authorizer to be configured on a broker (when executed with --bootstrap-server option) or throws a SecurityDisabledException:
// kafka-acls.sh --list --bootstrap-server :9092
Error while executing ACL command: org.apache.kafka.common.errors.SecurityDisabledException: No Authorizer is configured on the broker

Executing Standalone Application — main Object Method

getFilteredResourceToAcls Internal Method
getFilteredResourceToAcls(
  authorizer: Authorizer,
  filters: Set[ResourcePatternFilter],
  listPrincipal: Option[KafkaPrincipal] = None
): Iterable[(Resource, Set[Acl])]
getFilteredResourceToAcls…​FIXME
Note
getFilteredResourceToAcls is used when…​FIXME
removeAcls Internal Method
removeAcls(
  authorizer: Authorizer,
  acls: Set[Acl],
  filter: ResourcePatternFilter): Unit
removeAcls…​FIXME
Note
removeAcls is used when…​FIXME