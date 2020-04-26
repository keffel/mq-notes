# npm run docs:dev --no-clear-screen
cmd="npm run"
if [ $# > 0 ] ; then
    if [ "$1" = "yarn" ] ; then
        cmd='yarn';
    fi
fi
cmd="$cmd docs:dev";
echo "execute: $cmd";
eval $cmd;
exit 0;