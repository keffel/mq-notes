const sidebar = require('./config/sidebar.js');

const nav = [
  { text: 'Home', link: '/' },
  { text: 'Notes', items: [
    { text: 'Kafka', link: '/kafka/' }, 
    { text: 'RabbitMQ', link: '/rabbitmq/' }
  ] },
  { text: 'Sources', items: [
    { text: 'Kafka', link: 'http://kafka.apache.org/' }, 
    { text: 'RabbitMQ', link: 'https://www.rabbitmq.com/' }
  ] }
];

module.exports = {
  title: 'MQ Notes',
  description: 'Message Queue Notes',
  author: 'zhangfucheng',
  head: [
    [ "link", {rel: "icon", href: "/logo-s.png"}], 
    [ "meta", { "name": "viewport", "content": "width=device-width,initial-scale=1,user-scalable=no" } ]
  ],
  theme: 'reco',
  themeConfig: {
    // 关闭主题颜色选择器
    themePicker: false,
    // 关闭腾讯失踪人口的404页面 
    noFoundPageByTencent: false, 
     // 博客配置
    blogConfig: {
      /* category: {
        location: 2,     // 在导航栏菜单中所占的位置，默认2
        text: 'Category' // 默认文案 “分类”
      },
      tag: {
        location: 3,     // 在导航栏菜单中所占的位置，默认3
        text: 'Tag'      // 默认文案 “标签”
      }*/
    }, 
    nav,
    sidebar, 
    lastUpdated: 'Last Updated'
  },
  markdown: {
    // markdown-it-anchor 的选项
    anchor: { permalink: false },
    // markdown-it-toc 的选项
    toc: { includeLevel: [1, 2] },
    extendMarkdown: md => {
      // 使用更多的 markdown-it 插件!
      md.use(require('markdown-it-plantuml'))
    }
  }
}