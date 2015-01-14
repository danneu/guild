exports.PORT = process.env.PORT || 3000;
// Format: postgres://<user>:<pass>@<host>:<port>/<dbname>
exports.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/guild';
// 'development' | 'production'
exports.NODE_ENV = process.env.NODE_ENV || 'development';

exports.RECAPTCHA_SITEKEY = process.env.RECAPTCHA_SITEKEY;
exports.RECAPTCHA_SITESECRET = process.env.RECAPTCHA_SITESECRET;

// Various configurable forum settings
exports.MIN_TOPIC_TITLE_LENGTH = process.env.MIN_TOPIC_TITLE_LENGTH || 3;
exports.MAX_TOPIC_TITLE_LENGTH = process.env.MAX_TOPIC_TITLE_LENGTH || 50;
exports.MIN_POST_LENGTH = process.env.MIN_POST_LENGTH || 3;
exports.MAX_POST_LENGTH = process.env.MAX_POST_LENGTH || 65535;
exports.MIN_UNAME_LENGTH = process.env.MIN_UNAME_LENGTH || 2;
exports.MAX_UNAME_LENGTH = process.env.MAX_UNAME_LENGTH || 15;

// Determines the link in password reset token email
exports.HOST = process.env.HOST || ('http://localhost:' + exports.PORT);
// Required for sending emails
exports.AWS_KEY = process.env.AWS_KEY;
exports.AWS_SECRET = process.env.AWS_SECRET;
exports.FROM_EMAIL = process.env.FROM_EMAIL;

// How many posts/PMs to display per page in topics/convos
exports.POSTS_PER_PAGE = process.env.POSTS_PER_PAGE || 20;
// How many recent posts to display on user profile
exports.RECENT_POSTS_PER_PAGE = process.env.RECENT_POSTS_PER_PAGE || 5;
exports.CONVOS_PER_PAGE = process.env.CONVOS_PER_PAGE || 10;

// newrelic
exports.NEW_RELIC_LICENSE_KEY = process.env.NEW_RELIC_LICENSE_KEY;
exports.NEW_RELIC_APP_NAME = process.env.NEW_RELIC_APP_NAME || 'localhost-guild';

// Subsystem checks

exports.IS_PM_SYSTEM_ONLINE = process.env.IS_PM_SYSTEM_ONLINE === 'true';
exports.IS_EMAIL_CONFIGURED = !!(exports.HOST &&
                                 exports.AWS_KEY &&
                                 exports.AWS_SECRET &&
                                 exports.FROM_EMAIL);

if (exports.NODE_ENV === 'development') {
  console.log('Config vars:');
  console.log(JSON.stringify(exports, null, '  '));
}
