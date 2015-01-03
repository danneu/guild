exports.PORT = process.env.PORT || 3000;
// Format: postgres://<user>:<pass>@<host>:<port>/<dbname>
exports.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/guild';
// 'development' | 'production'
exports.NODE_ENV = process.env.NODE_ENV || 'development';

exports.RECAPTCHA_SITEKEY = process.env.RECAPTCHA_SITEKEY;
exports.RECAPTCHA_SITESECRET = process.env.RECAPTCHA_SITESECRET;

// Determines the link in password reset token email
exports.HOST = process.env.HOST || ('http://localhost:' + exports.PORT);
// Required for sending emails
exports.AWS_KEY = process.env.AWS_KEY;
exports.AWS_SECRET = process.env.AWS_SECRET;
exports.FROM_EMAIL = process.env.FROM_EMAIL;

// Subsystem checks

exports.IS_EMAIL_CONFIGURED = !!(exports.HOST &&
                                 exports.AWS_KEY &&
                                 exports.AWS_SECRET &&
                                 exports.FROM_EMAIL);

if (exports.NODE_ENV === 'development') {
  console.log('Config vars:');
  console.log(JSON.stringify(exports, null, '  '));
}
