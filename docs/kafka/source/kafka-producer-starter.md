---
title: Kafka老版生产者
date: 2018-06-28
---

这一部分介绍Kafka老版本的生产者，Kafka本身定义了一套交互协议，任意客户端代码只要遵循这个协议，就能够和服务端进行交互，在`core`模块的`kafka.producer`包里面，放着这个老版的Producer实现，`0.10.0.0`之后被废弃，高版本使用`clients`模块中的`KafkaProducer`实现。

    long events = Long.parseLong(args[0]);
    Random rnd = new Random();

    Properties props = new Properties();
    props.put("metadata.broker.list", "broker1:9092,broker2:9092 ");
    props.put("serializer.class", "kafka.serializer.StringEncoder");
    props.put("partitioner.class", "example.producer.SimplePartitioner");
    props.put("request.required.acks", "1");

    ProducerConfig config = new ProducerConfig(props);

    Producer<String, String> producer = new Producer<String, String>(config);

    for (long nEvents = 0; nEvents < events; nEvents++) { 
           long runtime = new Date().getTime();  
           String ip = “192.168.2.” + rnd.nextInt(255); 
           String msg = runtime + “,www.example.com,” + ip; 
           KeyedMessage<String, String> data = new KeyedMessage<String, String>("page_visits", ip, msg);
           producer.send(data);
    }
    producer.close();

Partition：

    import kafka.producer.Partitioner;
    import kafka.utils.VerifiableProperties;
     
    public class SimplePartitioner implements Partitioner {
        
        public SimplePartitioner (VerifiableProperties props) {     
        }
     
        public int partition(Object key, int a_numPartitions) {
            int partition = 0;
            String stringKey = (String) key;
            int offset = stringKey.lastIndexOf('.');
            if (offset > 0) {
               partition = Integer.parseInt( stringKey.substring(offset+1)) % a_numPartitions;
            }
           return partition;
        }
     
    }

