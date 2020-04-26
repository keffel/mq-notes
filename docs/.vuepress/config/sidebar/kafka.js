module.exports = {
    '/kafka/': [
        {
            title: 'Kafka使用文档',
            collapsable: true,
            sidebarDepth: 3,
            children: [
                '/kafka/usage/kafka-acls'
            ]
        },
        {
            title: 'Kafka源码走读',
            collapsable: true,
            sidebarDepth: 3,
            children: [
                '/kafka/source/kafka-consumer-partition-assignor',
                '/kafka/source/kafka-controller-kafka-controller',
                '/kafka/source/kafka-controller-controller-event-manager',
                '/kafka/source/kafka-message-message',
                '/kafka/source/kafka-network',
                '/kafka/source/kafka-network-socket-server',
                '/kafka/source/kafka-security-auth-authorizer',
                '/kafka/source/kafka-log-log-cleaner',
                '/kafka/source/kafka-log-log-cleaner-manager',
                '/kafka/source/kafka-log-index',
                '/kafka/source/kafka-log-offset-map',
                '/kafka/source/kafka-utils-kafka-scheduler',
                '/kafka/source/kafka-utils-throttler'
            ]
        }
    ]
};