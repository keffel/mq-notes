#!/usr/bin/env sh

# 终止一个错误
set -e

# 构建
cmd="npm run"
if [ $# > 0 ] ; then
    if [ "$1" = "yarn" ] ; then
        cmd='yarn';
    fi
fi
cmd="$cmd docs:build";
eval $cmd;
# npm run docs:build

scp -r docs/.vuepress/dist/* root@oneboxhost:/home/work/app/java-libraries-guide/

# 进入生成的构建文件夹
#cd docs/.vuepress/dist

# 如果你是要部署到自定义域名
# echo 'www.example.com' > CNAME

#git init
#git add -A
#git commit -m 'deploy'

# 如果你想要部署到 https://<USERNAME>.github.io
# git push -f git@github.com:<USERNAME>/<USERNAME>.github.io.git master

# 如果你想要部署到 https://<USERNAME>.github.io/<REPO>
# git push -f git@github.com:<USERNAME>/<USERNAME>.git master:gh-pages

#cd -