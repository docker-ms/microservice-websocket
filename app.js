'use strict';

const os = require('os');
const fs = require('fs');
const tls = require('tls');
const https = require('https');
const cluster = require('cluster');

const grpc = require('grpc');

const CommonImport = require('./util/CommonImport');

/*
 * Constants define.
 */
global.CONSUL = require('microservice-consul');

global.serviceTags = {
  chat: 'chat-' + (process.env.SERVICE_TAG_SUFFIX || '')
};

global.RELATED_MONGODB_COLLECTIONS = {
  usersCollectionName: 'Users',
  groupsCollectionName: 'Groups',
  conversationsCollectionName: 'Conversations'
};

const uwsServerPath = '/vcube';
const tlsCertsBasePath = CommonImport.path.join(__dirname, './tls_certs');

if (cluster.isMaster) {
  /*
   * The master process should be kept as light as it can be, that is: only do the workers management jobs.
   */

  const workers = [];
  const numOfWorkers = os.cpus().length;
  for (var i = 0; i < numOfWorkers; i++) {
    workers.push(cluster.fork());
  }

  cluster.on('exit', (worker, code, signal) => {
    workers.filter((item) => {
      return item.id !== worker.id;
    });
    workers.push(cluster.fork());
  });

  cluster.on('message', (worker, message, handle) => {
    workers.forEach((w) => {
      if (w.id !== worker.id) {
        w.send(message);
      }
    });
  });

} else {

  /*
   * Here the woker process will always be full featured.
   */

  CommonImport.utils.bluebirdRetryExecutor(() => {

    let doInitialization = [];

    doInitialization.push(
      require('microservice-mongodb-conn-pools')(global.CONSUL.keys.mongodbGate).then((dbPools) => {
        return dbPools;
      })
    );

    doInitialization.push(
      require('microservice-rabbitmq-channels-pool')(
        global.CONSUL.keys['rabbitmq'],
        ['gate-ex-to-ws', 'gate-ex-ws-loopback'],
        process.env.SERVICE_TAG_SUFFIX)
    );

    doInitialization.push(
      CommonImport.utils.pickRandomly(global.CONSUL.agents).kv.get(global.CONSUL.keys['jwtGate'])
    );

    doInitialization.push(
      CommonImport.utils.getLatestAliveGrpcClientsAndRemoveDeadServices(
        global.CONSUL.agents,
        Object.keys(global.serviceTags).map(key => global.serviceTags[key]),
        grpc,
        CommonImport.protos
      )
    );

    doInitialization = global.CONSUL.keys.tlsCerts.reduce((acc, curr) => {
      Object.keys(curr).forEach((item) => {
        if (item !== 'domain') {
          acc.push(
            CommonImport.utils.writeConsulDataToFile(
              global.CONSUL.agents, curr[item].consulKey,
              CommonImport.path.join(tlsCertsBasePath, curr.domain), curr[item].filename
            )
          );
        }
      });
      return acc;
    }, doInitialization);

    return CommonImport.Promise.all(doInitialization).then((results) => {

      if (results[0].length === 0) {
        return CommonImport.Promise.reject(new Error('None of the mongodb servers is available.'));
      }

      if (!results[1].channels.length) {
        return CommonImport.Promise.reject(new Error('None of the RabbitMQ servers is available.'));
      }

      if (!results[2]) {
        return CommonImport.Promise.reject(new Error('Invalid gate JWT configurations.'));
      }

      if (Object.keys(results[3]).length !== Object.keys(global.serviceTags).length) {
        return CommonImport.Promise.reject(new CommonImport.errors.RetryRecoverable());
      }

      global.DB_POOLS = results[0];

      global.RabbitMQ = results[1];

      global.JWT_GATE_OPTS = JSON.parse(results[2].Value);

      global.GRPC_CLIENTS = results[3];

    }).then(() => {

      const _startWSServer = () => {
        const options = {
          SNICallback: (domain, callback) => {
            const targetDomainCerts = global.CONSUL.keys.tlsCerts.find((item) => {
              return domain.indexOf(item.domain.replace('*.', '')) !== -1;
            });

            const ctx = tls.createSecureContext({
              key: fs.readFileSync(CommonImport.path.join(tlsCertsBasePath, targetDomainCerts.domain, targetDomainCerts.key.filename)),
              cert: fs.readFileSync(CommonImport.path.join(tlsCertsBasePath, targetDomainCerts.domain, targetDomainCerts.cert.filename)),
              ca: [fs.readFileSync(CommonImport.path.join(tlsCertsBasePath, targetDomainCerts.domain, targetDomainCerts.ca.filename))]
            });

            callback(null, ctx);
          },
          requestCert: false,
          rejectUnauthorized: false
        };

        const server = https.createServer(options);

        const uws = new (require('uws').Server)({
          port: 9999,
          path: uwsServerPath,
          noServer: false,
          server: server,
          clientTracking: false,
          // Hixie draft 76 (Old and deprecated, but still in use by Safari and Opera. Can be disabled by setting the disableHixie option to true.)
          disableHixie: true,
          perMessageDeflate: {
            serverNoContextTakeover: true,
            clientNoContextTakeover: true,
            serverMaxWindowBits: 15,
            clientMaxWindowBits: 15,
            memLevel: 8
          },
          verifyClient: (info, callback) => {
            /*
             * `info` Object
             *   `origin` String: The value in the Origin header indicated by the client.
             *   `req` http.ClientRequest: The client HTTP GET request.
             *   `secure` Boolean: true if req.connection.authorized or req.connection.encrypted is set.
             *
             * `cb` Function: A callback that must be called by the user upon inspection of the info fields. Arguments in this callback are:
             *   `result` Boolean: Whether the user accepts or not the handshake.
             *   `code` Number: If result is false this field determines the HTTP error status code to be sent to the client.
             *   `name` String: If result is false this field determines the HTTP reason phrase.
             *
             */
            const cookies = info.req.headers.cookie.split(';').reduce((acc, curr) => {
              const kvArr = curr.split('=');
              acc[kvArr[0].trim()] = kvArr[1].trim();
              return acc;
            }, {})

            const decodedAccessToken = CommonImport.jwt.decode(cookies.accessToken);

            if (decodedAccessToken) {
              CommonImport.Promise.promisify(CommonImport.jwt.verify)(cookies.accessToken, global.JWT_GATE_OPTS.strSecret).then(() => {
                callback(true);
              }).catch((err) => {
                const invalidToken = new CommonImport.errors.TokenError.InvalidToken();
                callback(false, invalidToken.httpStatusCode, invalidToken.errMsg);
              });
            } else {
              const invalidToken = new CommonImport.errors.TokenError.InvalidToken();
              callback(false, invalidToken.httpStatusCode, invalidToken.errMsg);
            }
            
          }
        });

        return uws;
      };

      return CommonImport.Promise.join(
        require('./util/InitUtil').loadActiveConversations(),
        _startWSServer(),
        (socketsByCidAndConvIdAndUidAndDid, uws) => {
          
          const wsrDealer = require('./modules/WSRDealer')({}, socketsByCidAndConvIdAndUidAndDid);

          require('./modules/WebSocketListener')(uws, wsrDealer);

          require('./modules/RabbitMQInteractor')(wsrDealer);

          process.on('message', (message) => {
            wsrDealer.messageDealer(message, 3);
          });

          return CommonImport.Promise.resolve();

        }
      );

    });

  }, {interval: 5000, timeout: 600000, maxTries: 65535});

}


