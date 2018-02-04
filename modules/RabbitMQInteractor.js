'use strict';

const os = require('os');

const CommonImport = require('../util/CommonImport');

module.exports = (wsrDealer) => {

  Object.keys(global.RabbitMQ.settings.exchanges['gate-ex-ws-loopback'].binds).forEach((bind) => {
    const channel = CommonImport.utils.pickRandomly(global.RabbitMQ.channels);
    channel.consume(
      global.RabbitMQ.settings.exchanges['gate-ex-ws-loopback'].binds[bind].mq.name,
      (msg) => {
        const data = JSON.parse(msg.content.toString());

        process.send(data);

        if (msg.properties.headers.publisher !== os.hostname()) {
          wsrDealer.messageDealer(data, 1);
        }
      }
    );
  });

  Object.keys(global.RabbitMQ.settings.exchanges['gate-ex-to-ws'].binds).forEach((bind) => {
    const channel = CommonImport.utils.pickRandomly(global.RabbitMQ.channels);
    channel.consume(
      global.RabbitMQ.settings.exchanges['gate-ex-to-ws'].binds[bind].mq.name,
      (msg) => {
        wsrDealer.messageDealer(JSON.parse(msg.content.toString()), 2);
      }, {
        noAck: true
      }
    ).then((consumerTag) => {
      // Nothing need to be done here.
    }).catch((err) => {
      console.log(err);
    });
  });
  
}


