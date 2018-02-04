'use strict';

const CommonImport = require('./CommonImport');

const batchSize = 1000;

class InitUtil {

  static loadActiveConversations() {
    return CommonImport.utils.bluebirdRetryExecutor(() => {

      const dbPool = CommonImport.utils.pickRandomly(global.DB_POOLS);
      const usersCollection = dbPool.collection(global.RELATED_MONGODB_COLLECTIONS.usersCollectionName);

      const data = {
        // {cid: {convId: {uid: {did_0: 'deviceId_0', did_1: 'deviceId_1'}}}}
        byCidAndConvIdAndUidAndDid: {},
        convIds: new Set(),
        conversationToCompany: {}
      };

      const usersStream = usersCollection.find({
        'activeConversations.0': {
          $exists: true
        }
      }, {
        _id: 0,
        userId: 1,
        companyId: 1,
        activeConversations: 1
      }).batchSize(batchSize).stream();

      usersStream.on('data', (user) => {
        user.activeConversations.forEach((conversationId) => {
          data.byCidAndConvIdAndUidAndDid[user.companyId] = data.byCidAndConvIdAndUidAndDid[user.companyId] || {};
          data.byCidAndConvIdAndUidAndDid[user.companyId][conversationId] = {};

          data.convIds.add(conversationId);
          data.conversationToCompany[conversationId] = user.companyId;
        });
      });

      return new CommonImport.Promise((resolve, reject) => {
        usersStream.on('end', () => {
          data.convIds = Array.from(data.convIds);
          return resolve(data);
        });
      });

    }, {}).then((data) => {
      data.forGroupIds = new Set();
      data.groupToConversation = {};

      return CommonImport.utils.bluebirdRetryExecutor(() => {

        const dbPool = CommonImport.utils.pickRandomly(global.DB_POOLS);
        const conversationsCollection = dbPool.collection(global.RELATED_MONGODB_COLLECTIONS.conversationsCollectionName);

        const conversationsStream = conversationsCollection.find({
          conversationId: {
            $in: data.convIds
          }
        }, {
          _id: 0,
          conversationId: 1,
          members: 1,
          forGroupId: 1
        }).batchSize(batchSize).stream();

        conversationsStream.on('data', (conversation) => {
          if (conversation.forGroupId) {
            data.forGroupIds.add(conversation.forGroupId);
            data.groupToConversation[conversation.forGroupId] = conversation.conversationId;
          } else {
            for (let userId in conversation.members) {
              data.byCidAndConvIdAndUidAndDid[
                data.conversationToCompany[conversation.conversationId]
              ][conversation.conversationId][userId] = {
                aux: conversation.members[userId]
              };
            }
          }
        });

        return new CommonImport.Promise((resolve, reject) => {
          conversationsStream.on('end', () => {
            data.forGroupIds = Array.from(data.forGroupIds);
            return resolve(data);
          });
        });

      }, {});
    }).then((data) => {
      if (data.forGroupIds.length) {
        return CommonImport.utils.bluebirdRetryExecutor(() => {

          const dbPool = CommonImport.utils.pickRandomly(global.DB_POOLS);
          const groupsCollection = dbPool.collection(global.RELATED_MONGODB_COLLECTIONS.groupsCollectionName);

          const groupsStream = groupsCollection.find({
            groupId: {
              $in: data.forGroupIds
            }
          }, {
            _id: 0,
            groupId: 1,
            members: 1,
            managers: 1,
            blockedMembers: 1
          }).batchSize(batchSize).stream();

          groupsStream.on('data', (group) => {
            for (let userId in group.members) {
              const tmp = data.byCidAndConvIdAndUidAndDid[
                data.conversationToCompany[data.groupToConversation[group.groupId]]
              ][
                data.groupToConversation[group.groupId]
              ][userId] = {
                aux: group.members[userId]
              };
              if (Array.isArray(group.managers) && group.managers.indexOf(userId) !== -1) {
                tmp.aux.isManager = true;
              }
              if (group.blockedMembers && group.blockedMembers[userId]) {
                tmp.aux.blocked = group.blockedMembers[userId];
              }
            }
          });

          return new CommonImport.Promise((resolve, reject) => {
            groupsStream.on('end', () => {
              return resolve(data.byCidAndConvIdAndUidAndDid);
            });
          });

        }, {});
      } else {
        return CommonImport.Promise.resolve(data.byCidAndConvIdAndUidAndDid);
      }
    });
  }

}

module.exports = InitUtil;


