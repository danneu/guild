'use strict';
// 3rd
const assert = require('better-assert')
const _ = require('lodash')
const uuid = require('uuid')
const debug = require('debug')('app:db')
const {extend, parseUrl} = require('pg-extra')
const pg = extend(require('pg'))
// 1st
const config = require('../config')
const belt = require('../belt')

// TODO: Update db/index.js to use this module,
//       and remove all those dead functions

// This is the connection pool the rest of our db namespace
// should import and use
const pool = new pg.Pool(parseUrl(config.DATABASE_URL))

module.exports = {pool}
