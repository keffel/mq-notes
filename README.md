## Message Queue Notes

### 站点使用的工具

vuepress

### 站点使用的主题

[vuepress-theme-reco](https://github.com/vuepress-reco/vuepress-theme-reco) | 
[文档](https://vuepress-theme-reco.recoluan.com)

vuepress本身是一个类似于Gitbook的工具，而reco是构建在vuepress之上针对博客的主题，提供了文章分类、分页、评论的功能，同时拥有vuepress原本的所有属性。

主题提供了`npx`、`npm`、`yarn`三种依赖管理工具，因为我本人不是前端工程师，熟悉的只是比较老的`npm`，`yarn`也用过几次，这里只贴这两种，`npx`没听过，不列。

如果要新建demo项目，可以用`npm`/`yarn`创建： 

    # init
    npm install @vuepress-reco/theme-cli -g # or: yarn global add @vuepress-reco/theme-cli
    theme-cli init my-blog
    
    # install
    cd my-blog
    npm install  # or: yarn install

    # run
    npm run dev  # or: yarn dev

    # build
    npm run build  # or: yarn build

如果是裸用，用下面的方法安装：

    npm install vuepress-theme-reco -dev--save
    # or
    yarn add vuepress-theme-reco

然后在配置中指定主题就可以了：

    // .vuepress/config.js

    module.exports = {
      theme: 'reco'
    }

## 依赖

    npm install vuepress-plugin-flowchart --save
    or
    yarn add vuepress-plugin-flowchart -D

    // https://plantuml.com/
    npm install markdown-it-plantuml --save
