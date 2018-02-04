'use strict';

module.exports = {
  path: require('path'),

  Promise: require('bluebird'),
  jwt: require('jsonwebtoken'),
  msgpack: require('msgpack'),

  protos: require('microservice-protos'),
  errors: require('microservice-errors'),
  utils: require('microservice-utils')
};


