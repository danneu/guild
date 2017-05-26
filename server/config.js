"use strict";
exports.PORT = parseInt(process.env.PORT, 10) || 3000;
// Format: postgres://<user>:<pass>@<host>:<port>/<dbname>
exports.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/guild';
// 'development' | 'production'
exports.NODE_ENV = process.env.NODE_ENV || 'development';

exports.RECAPTCHA_SITEKEY = process.env.RECAPTCHA_SITEKEY;
exports.RECAPTCHA_SITESECRET = process.env.RECAPTCHA_SITESECRET;

// aws-sdk listens for these env vars
// TODO: Remove my own aws env vars (AWS_SECRET, AWS_KEY) and use these
exports.AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
exports.AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Various configurable forum settings
exports.MIN_TOPIC_TITLE_LENGTH = parseInt(process.env.MIN_TOPIC_TITLE_LENGTH, 10) || 3;
exports.MAX_TOPIC_TITLE_LENGTH = parseInt(process.env.MAX_TOPIC_TITLE_LENGTH, 10) || 150;
exports.MIN_POST_LENGTH = parseInt(process.env.MIN_POST_LENGTH, 10) || 1;
exports.MAX_POST_LENGTH = parseInt(process.env.MAX_POST_LENGTH, 10) || 150000;
exports.MIN_UNAME_LENGTH = parseInt(process.env.MIN_UNAME_LENGTH, 10) || 2;
exports.MAX_UNAME_LENGTH = parseInt(process.env.MAX_UNAME_LENGTH, 10) || 15;
exports.MAX_BIO_LENGTH = parseInt(process.env.MAX_BIO_LENGTH) || 100000;
exports.MAX_VM_LENGTH = parseInt(process.env.MAX_VM_LENGTH) || 300;

exports.LATEST_RPGN_TOPIC_ID = parseInt(process.env.LATEST_RPGN_TOPIC_ID) || undefined;
exports.LATEST_RPGN_IMAGE_URL = process.env.LATEST_RPGN_IMAGE_URL || undefined;

exports.CURRENT_FEEDBACK_TOPIC_ID = parseInt(process.env.CURRENT_FEEDBACK_TOPIC_ID, 10) || undefined;

// These are limits on the number of notifications a user can generate from a
// single post. If the limit of MENTIONS_PER_POST is 10 and a user mentions 15
// people, then only the first 10 will trigger notifications.
exports.MENTIONS_PER_POST = parseInt(process.env.MENTIONS_PER_POST) || 10;
exports.QUOTES_PER_POST = parseInt(process.env.QUOTES_PER_POST) || 10;

// Determines the link in password reset token email
exports.HOST = process.env.HOST || ('http://localhost:' + exports.PORT);
// Required for sending emails
exports.AWS_KEY = process.env.AWS_KEY;
exports.AWS_SECRET = process.env.AWS_SECRET;
exports.S3_AVATAR_BUCKET = process.env.S3_AVATAR_BUCKET;
exports.S3_IMAGE_BUCKET = process.env.S3_IMAGE_BUCKET;
if (!exports.S3_AVATAR_BUCKET) {
  console.warn('S3_AVATAR_BUCKET not set. Cannot process avatars.');
}
if (!exports.S3_IMAGE_BUCKET) {
  console.warn('S3_IMAGE_BUCKET not set. Cannot process image uploads.');
}

exports.MAX_CONVO_PARTICIPANTS = parseInt(process.env.MAX_CONVO_PARTICIPANTS) || 10;

// The max amount of co-GMs per topic
exports.MAX_CO_GM_COUNT = process.env.MAX_CO_GM_COUNT || 2;

// How many posts/PMs to display per page in topics/convos
exports.POSTS_PER_PAGE = parseInt(process.env.POSTS_PER_PAGE, 10) || 20;
// How many users to display per page in user search
exports.USERS_PER_PAGE = parseInt(process.env.USERS_PER_PAGE, 10) || 20;
// How many recent posts to display on user profile
exports.RECENT_POSTS_PER_PAGE = parseInt(process.env.RECENT_POSTS_PER_PAGE, 10) || 5;
exports.CONVOS_PER_PAGE = parseInt(process.env.CONVOS_PER_PAGE, 10) || 10;

exports.FAQ_POST_ID = parseInt(process.env.FAQ_POST_ID, 10) || undefined
exports.WELCOME_POST_ID = parseInt(process.env.WELCOME_POST_ID, 10) || undefined

// Used as the sender of the welcome PM
// On the Guild, this is set to a user named "Guild Mods" that the mods
// can log into. You will want to periodically check this account to follow
// up with users that respond to the welcome PM
exports.STAFF_REPRESENTATIVE_ID = parseInt(process.env.STAFF_REPRESENTATIVE_ID);

// For /search endpoint
exports.SEARCH_RESULTS_PER_PAGE = parseInt(process.env.SEARCH_RESULTS_PER_PAGE) || 50;

// Users to hide from reverse-lookup
exports.CLOAKED_SLUGS = (process.env.CLOAKED_SLUGS || '')
  .split(',')
  .filter(Boolean)

exports.ENABLE_ADS = !!process.env.ENABLE_ADS;

exports.CHAT_SERVER_URL = process.env.CHAT_SERVER_URL || 'http://localhost:3001';

// newrelic
exports.NEW_RELIC_LICENSE_KEY = process.env.NEW_RELIC_LICENSE_KEY;
exports.NEW_RELIC_APP_NAME = process.env.NEW_RELIC_APP_NAME || 'localhost-guild';

// akismet
exports.AKISMET_KEY = process.env.AKISMET_KEY

// /rules redirect and sidebar link
exports.RULES_POST_ID = Number.parseInt(process.env.RULES_POST_ID, 10) || null

// Discord / OAuth
exports.DISCORD_APP_CLIENTID = process.env.DISCORD_APP_CLIENTID
exports.DISCORD_APP_CLIENTSECRET = process.env.DISCORD_APP_CLIENTSECRET
exports.DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID
exports.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
exports.IS_DISCORD_CONFIGURED = !!(
  exports.DISCORD_APP_CLIENTID &&
  exports.DISCORD_APP_CLIENTSECRET &&
  exports.DISCORD_GUILD_ID &&
  exports.DISCORD_BOT_TOKEN
);
console.log('Discord configured:', exports.IS_DISCORD_CONFIGURED)

// Subsystem checks

exports.IS_PM_SYSTEM_ONLINE = process.env.IS_PM_SYSTEM_ONLINE === 'true';
console.log('PM system online:', exports.IS_PM_SYSTEM_ONLINE);

exports.IS_EMAIL_CONFIGURED = !!(exports.HOST &&
                                 exports.AWS_KEY &&
                                 exports.AWS_SECRET);
console.log('Email is configured:', exports.IS_EMAIL_CONFIGURED);

if (exports.NODE_ENV === 'development') {
  console.log('Config vars:');
  console.log(JSON.stringify(exports, null, '  '));
}
