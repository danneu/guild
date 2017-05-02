// Node deps
const path = require('path');
const fs = require('fs');
// 3rd party
const pg = require('co-pg')(require('pg'));
const _ = require('lodash');
const promiseMap = require('promise.map')
// 1st party
const config = require('./config');
const db = require('./db')
const {pool} = require('./db/util')
const {sql, _raw} = require('pg-extra')


if (config.NODE_ENV !== 'development') {
  console.log('can only reset db in development')
  process.exit(1)
}

if (!/localhost/.test(config.DATABASE_URL)) {
  console.log('can only reset a localhost db')
  process.exit(1)
}


////////////////////////////////////////////////////////////

function slurpSqlSync (filePath) {
  const relativePath = '../sql/' + filePath
  const fullPath = path.join(__dirname, relativePath)
  return fs.readFileSync(fullPath, 'utf8')
}

function timeout (ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function resetDb () {
  // Create tables
  await (async () => {
    const str = slurpSqlSync('schema.sql');
    await pool.query(_raw`${str}`);
    console.log('Reset schema.sql');
  })()

  // Triggers
  await (async () => {
    const str = slurpSqlSync('functions_and_triggers.sql');
    await pool.query(_raw`${str}`);
    console.log('Reset functions_and_triggers.sql');
  })()

  // Seed data
  await (async () => {
    const str = slurpSqlSync('dev_seeds.sql');
    await pool.query(_raw`${str}`);
    console.log('Inserted dev_seeds.sql');
  })()

  // Insert 100 topics for forum1
  await (async () => {
    console.log('Inserting 100 topics into forum 1')
    await promiseMap(_.range(100), (n) => {
      const markup = 'Post ' + n;
      return db.createTopic({
        userId: 1, forumId: 1, ipAddress: '1.2.3.4',
        title: 'My topic ' + n,
        markup: markup, html: markup,
        isRoleplay: false, postType: 'ooc'
      })
    }, 1)
  })()

  // Insert 100 posts for topic1
  await (async () => {
    console.log('Inserting 100 posts into topic 1')
    await promiseMap(_.range(100), (n) => {
      const markup = n.toString()
      return db.createPost({
        userId: 1, ipAddress: '1.2.3.4',
        markup: markup, html: markup,
        topicId: 1, isRoleplay: false,
        type: 'ooc'
      });
    }, 1)
  })()
}

if (!module.parent) {
  // Called from cli
  const succBack = () => { console.log('Database reset!'); process.exit() }
  const errBack = (err) => { console.error('Caught error: ', err, err.stack) };
  console.log('Resetting the database...');
  resetDb().then(succBack, errBack)
}
