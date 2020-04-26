module.exports = Object.assign({}, 
    require('./sidebar/kafka.js'), 
    require('./sidebar/rabbitmq.js'),
    {
    '/': [
        ''         /* / */
    ]
})