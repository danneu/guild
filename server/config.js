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
exports.AWS_CLOUDSEARCH_DOCUMENT_ENDPOINT = process.env.AWS_CLOUDSEARCH_DOCUMENT_ENDPOINT;
exports.AWS_CLOUDSEARCH_SEARCH_ENDPOINT = process.env.AWS_CLOUDSEARCH_SEARCH_ENDPOINT;

// Various configurable forum settings
exports.MIN_TOPIC_TITLE_LENGTH = parseInt(process.env.MIN_TOPIC_TITLE_LENGTH, 10) || 3;
exports.MAX_TOPIC_TITLE_LENGTH = parseInt(process.env.MAX_TOPIC_TITLE_LENGTH, 10) || 150;
exports.MIN_POST_LENGTH = parseInt(process.env.MIN_POST_LENGTH, 10) || 1;
exports.MAX_POST_LENGTH = parseInt(process.env.MAX_POST_LENGTH, 10) || 150000;
exports.MIN_UNAME_LENGTH = parseInt(process.env.MIN_UNAME_LENGTH, 10) || 2;
exports.MAX_UNAME_LENGTH = parseInt(process.env.MAX_UNAME_LENGTH, 10) || 15;
exports.MAX_BIO_LENGTH = parseInt(process.env.MAX_BIO_LENGTH) || 3000;

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
// Bucket will get an avatars/ folder in it with many avatars/<imageHash>.<ext>
exports.S3_BUCKET = process.env.S3_BUCKET;
if (!exports.S3_BUCKET) console.warn('S3_BUCKET not set. Cannot process avatars.');
exports.FROM_EMAIL = process.env.FROM_EMAIL;

// The max amount of co-GMs per topic
exports.MAX_CO_GM_COUNT = process.env.MAX_CO_GM_COUNT || 2;

// How many posts/PMs to display per page in topics/convos
exports.POSTS_PER_PAGE = parseInt(process.env.POSTS_PER_PAGE, 10) || 20;
// How many users to display per page in user search
exports.USERS_PER_PAGE = parseInt(process.env.USERS_PER_PAGE, 10) || 20;
// How many recent posts to display on user profile
exports.RECENT_POSTS_PER_PAGE = parseInt(process.env.RECENT_POSTS_PER_PAGE, 10) || 5;
exports.CONVOS_PER_PAGE = parseInt(process.env.CONVOS_PER_PAGE, 10) || 10;

// Used as the sender of the welcome PM
// On the Guild, this is set to a user named "Guild Mods" that the mods
// can log into. You will want to periodically check this account to follow
// up with users that respond to the welcome PM
exports.STAFF_REPRESENTATIVE_ID = parseInt(process.env.STAFF_REPRESENTATIVE_ID);

// For /search endpoint
exports.SEARCH_RESULTS_PER_PAGE = parseInt(process.env.SEARCH_RESULTS_PER_PAGE) || 50;

exports.ENABLE_ADS = !!process.env.ENABLE_ADS;

// newrelic
exports.NEW_RELIC_LICENSE_KEY = process.env.NEW_RELIC_LICENSE_KEY;
exports.NEW_RELIC_APP_NAME = process.env.NEW_RELIC_APP_NAME || 'localhost-guild';

// Subsystem checks

exports.IS_PM_SYSTEM_ONLINE = process.env.IS_PM_SYSTEM_ONLINE === 'true';
console.log('PM system online:', exports.IS_PM_SYSTEM_ONLINE);

exports.IS_EMAIL_CONFIGURED = !!(exports.HOST &&
                                 exports.AWS_KEY &&
                                 exports.AWS_SECRET &&
                                 exports.FROM_EMAIL);
console.log('Email is configured:', exports.IS_EMAIL_CONFIGURED);

exports.IS_CLOUDSEARCH_CONFIGURED = !!(
  exports.AWS_ACCESS_KEY_ID,
  exports.AWS_SECRET_ACCESS_KEY,
  exports.AWS_CLOUDSEARCH_DOCUMENT_ENDPOINT,
  exports.AWS_CLOUDSEARCH_SEARCH_ENDPOINT
);
console.log('Cloudsearch is configured:', exports.IS_CLOUDSEARCH_CONFIGURED);


if (exports.NODE_ENV === 'development') {
  console.log('Config vars:');
  console.log(JSON.stringify(exports, null, '  '));
}
