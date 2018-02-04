'use strict';

const CommonImport = require('../util/CommonImport');

module.exports = (uws, wsrDealer) => {

  uws.on('connection', (socket) => {

    socket.isAlive =true;

    socket.on('pong', () => {
      socket.isAlive = true;
    });

    const interval = setInterval(() => {
      uws.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          wsrDealer.uponConnOrLostConn.bind(wsrDealer, socket, 0);
          return ws.terminate();
        }

        ws.isAlive = false;
        ws.ping('');
      });
    }, 15000);

    wsrDealer.uponConnOrLostConn(socket, 1);

    socket.on('close', (code, message) => {
      wsrDealer.uponConnOrLostConn(socket, 0);
    });

    socket.on('error', (error) => {
      throw error;
    });
    
    socket.on('message', (message) => {
      // const rawBinary = new Uint8Array(message);
      // const unpackedRecvMsg = CommonImport.msgpack.unpack(rawBinary);
      const unpackedRecvMsg = JSON.parse(message);
      unpackedRecvMsg.sender = socket.clientInfo.uid;
      wsrDealer.messageDealer({
        message: unpackedRecvMsg,
        aux: socket.clientInfo
      }, 0);

      CommonImport.utils.bluebirdRetryExecutor(() => {
        const chatGrpcClient = CommonImport.utils.pickRandomly(global.GRPC_CLIENTS[global.serviceTags.chat]);
        return new CommonImport.Promise((resolve, reject) => {
          return chatGrpcClient.checkQualificationAndSaveMessageV1(unpackedRecvMsg, (err, data) => {
            if (err) {
              return reject(err);
            }
            return resolve(data);
          });
        });
      }, {}).then((data) => {
        // TODO: emit ack...
      });
    });

  });

  uws.on('error', (error) => {
    throw error;
  });

};


