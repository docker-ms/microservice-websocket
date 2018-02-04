'use strict';

const os = require('os');

const CommonImport = require('./CommonImport');

class RabbitMQ {

  static publishToWsLoopback(toBePublishedData) {

    switch (CommonImport.protos.enums.messageTypes[toBePublishedData.message.messageType]) {

      case CommonImport.protos.enums.messageTypes.TEXT:
        this._publish(
          global.RabbitMQ.settings.exchanges['gate-ex-ws-loopback'].name,
          global.RabbitMQ.settings.exchanges['gate-ex-ws-loopback'].binds.forTextMessage.routingKey,
          toBePublishedData
        ).then((publishRes) => {
          // Anything need to be done here?
        }).catch((err) => {
          // TODO: failed to publish, should do something here.
        });

        break;

      case CommonImport.protos.enums.messageTypes.FILE:
      case CommonImport.protos.enums.messageTypes.IMAGE:
      case CommonImport.protos.enums.messageTypes.AUDIO:
        break;

      case CommonImport.protos.enums.messageTypes.VIDEO:
        break;

      case CommonImport.protos.enums.messageTypes.MULTI:
        break;
        
    }

  }

  static _publish(exchange, routingKey, content) {
    return CommonImport.utils.bluebirdRetryExecutor(() => {
      return CommonImport.utils.pickRandomly(global.RabbitMQ.channels).publish(
        exchange,
        routingKey,
        new Buffer(JSON.stringify(content)),
        {
          persistent: false,
          mandatory: true,
          headers: {
            publisher: os.hostname()
          }
        }
      );
    }, {});
  }

}

module.exports = RabbitMQ;


