'use strict';

const os = require('os');

const CommonImport = require('../util/CommonImport');

const RabbitMQ = require('../util/RabbitMQ');

module.exports = (socketsByCidAndUidAndDid, socketsByCidAndConvIdAndUidAndDid) => {

  /*
   * `socketsByCidAndUidAndDid` object structure:
   *   {cid: {uid: {did_0: 'deviceId_0', did_1: 'deviceId_1'}}}
   *
   * `socketsByCidAndConvIdAndUidAndDid` object structure:
   *   {cid: {convId: {uid: {did_0: 'deviceId_0', did_1: 'deviceId_1'}}}}
   */

  const _updateSocketsByCidAndConvIdAndUidAndDid = {
    addNewConversation: (data) => {
      const targetConversation = socketsByCidAndConvIdAndUidAndDid[data.aux.cid][data.message.toConversationId] = {};
      Object.keys(data.targetUsers).forEach((userId) => {
        // Set user 'isManager' tag.
        if (data.aux.managerUserIds && data.aux.managerUserIds.indexOf(userId) !== -1) {
          targetConversation[userId] = {
            aux: {
              isManager: true
            }
          }
        } else {
          targetConversation[userId] = {aux: {}};
        }
        // Set user 'joinInAt' tag.
        targetConversation[userId].aux['joinInAt'] = data.targetUsers[userId].joinInAt;
        // Set user 'blocked' tag.
        if (data.aux.blockedMembers && data.aux.blockedMembers[userId]) {
          targetConversation[userId].aux.blocked = data.aux.blockedMembers[userId];
        }
        // Graft user connected devices.
        const userConnectedDevices = socketsByCidAndUidAndDid[data.aux.cid][userId];
        if (userConnectedDevices) {
          for (let did in userConnectedDevices) {
            targetConversation[userId][did] = userConnectedDevices[did];
          }
        }
      });
    }
  };

  const _sendMessageToDevices = (data, toConversation) => {
    for (let uid in toConversation) {
      if (uid === data.aux.uid) {
        for (let did in toConversation[uid]) {
          if (did !== 'aux' && did !== data.aux.did) {
            // toConversation[uid][did] && toConversation[uid][did].send(CommonImport.msgpack.pack(data.message));
            toConversation[uid][did] && toConversation[uid][did].send(JSON.stringify(data.message));
          }
        }
      } else {
        for (let did in toConversation[uid]) {
          if (did !== 'aux') {
            // toConversation[uid][did] && toConversation[uid][did].send(CommonImport.msgpack.pack(data.message));
            toConversation[uid][did] && toConversation[uid][did].send(JSON.stringify(data.message));
          }
        }
      }
    }
  };

  return {

    /*
     * `operationType`:
     *   0 -> delete
     *   1 -> add
     */
    uponConnOrLostConn: (socket, operationType) => {
      let clientCid;
      let clientUid;
      let clientDid;
      switch (operationType) {
        case 0:
          socket.terminate();

          clientCid = socket.clientInfo.cid;
          clientUid = socket.clientInfo.uid;
          clientDid = socket.clientInfo.did;

          /*
           * Delete 'user device socket connection' from `socketsByCidAndUidAndDid`.
           */
          delete socketsByCidAndUidAndDid[clientCid][clientUid][clientDid]

          /*
           * Delete 'user device socket connection' from `socketsByCidAndConvIdAndUidAndDid`.
           */
          Object.keys(socketsByCidAndConvIdAndUidAndDid[clientCid]).forEach((convId) => {
            if (Object.keys(socketsByCidAndConvIdAndUidAndDid[clientCid][convId]).indexOf(clientUid) !== -1) {
              delete socketsByCidAndConvIdAndUidAndDid[clientCid][convId][clientUid][clientDid];
            }
          });

          break;

        case 1:
          const cookies = socket.upgradeReq.headers.cookie.split(';').reduce((acc, curr) => {
            const kvArr = curr.split('=');
            acc[kvArr[0].trim()] = kvArr[1].trim();
            return acc;
          }, {})

          const decodedAccessToken = CommonImport.jwt.decode(cookies.accessToken);

          clientCid = decodedAccessToken.cid;
          clientUid = decodedAccessToken.uid;
          clientDid = decodedAccessToken.did;

          socket.clientInfo = {
            cid: clientCid,
            uid: clientUid,
            did: clientDid
          };

          /*
           * Add 'user device socket connection' to `socketsByCidAndUidAndDid`.
           */
          socketsByCidAndUidAndDid[clientCid] = socketsByCidAndUidAndDid[clientCid] || {};
          socketsByCidAndUidAndDid[clientCid][clientUid] = socketsByCidAndUidAndDid[clientCid][clientUid] || {};
          socketsByCidAndUidAndDid[clientCid][clientUid][clientDid] = socket;

          /*
           * Add 'user device socket connection' to `socketsByCidAndConvIdAndUidAndDid`.
           */
          socketsByCidAndConvIdAndUidAndDid[clientCid] = socketsByCidAndConvIdAndUidAndDid[clientCid] || {};
          Object.keys(socketsByCidAndConvIdAndUidAndDid[clientCid]).forEach((convId) => {
            if (Object.keys(socketsByCidAndConvIdAndUidAndDid[clientCid][convId]).indexOf(clientUid) !== -1) {
              socketsByCidAndConvIdAndUidAndDid[clientCid][convId][clientUid][clientDid] = socket;
            }
          });

          break;
      }
    },

    /*
     * type:
     *   0 -> data are coming from 'client device'.
     *   1 -> data are coming from 'ws-loopback' queue.
     *   2 -> data are coming from 'to-ws' queue.
     *   3 -> data are coming from 'process.send'.
     */
    messageDealer: (data, type) => {
      let toConversation = socketsByCidAndConvIdAndUidAndDid[data.aux.cid][data.message.toConversationId];
      switch (type) {
        case 0:
          if (toConversation) {
            const conversationMemberUserIds = Object.keys(toConversation);

            if (conversationMemberUserIds.indexOf(data.aux.uid) === -1) {
              // Discard this message, coz sender is not member of this conversation.
            }

            if (toConversation[data.aux.uid].blocked) {
              // Discard this message, coz sender is blocked.
            }

            let areMentionedUsersAllValid = true;
            if (Array.isArray(data.message.mentionedUserUserIds) && data.message.mentionedUserUserIds.length) {
              areMentionedUsersAllValid = data.message.mentionedUserUserIds.every((mentionedUserUserId) => {
                if (Object.keys(toConversation).indexOf(mentionedUserUserId) !== -1) {
                  return false;
                }
                return true;
              });
            }
            if (!areMentionedUsersAllValid) {
              // Discard message, coz there is user in the mentioned users list which not belong to this conversation.
            }

            if (Array.isArray(data.message.mentionedMessageMessageIds) && data.message.mentionedMessageMessageIds.length) {
              /*
               * TODO: need to check and fetch the mentioned messages, then can continue the process.
               */
              return;
            }

            _sendMessageToDevices(data, toConversation);

            /*
             * Publish to RabbitMQ 'gate-ex-ws-loopback'.
             */
            RabbitMQ.publishToWsLoopback(data);
            
          } else {
            /*
             * TODO: no conversation found here:
             *   grpc call 'checkQualificationAndSaveMessage' which belongs to 'ms-chat'.
             */
          }

          break;

        case 1:
        case 3:
          _sendMessageToDevices(data, toConversation);
          break;

        case 2:
          data.message.sender = data.aux.uid;
          if (toConversation) {
            _sendMessageToDevices(data, toConversation)
          } else {
            _updateSocketsByCidAndConvIdAndUidAndDid.addNewConversation(data);
            toConversation = socketsByCidAndConvIdAndUidAndDid[data.aux.cid][data.message.toConversationId];
            _sendMessageToDevices(data, toConversation);
          }
          break;
      }
    }

  };

};


