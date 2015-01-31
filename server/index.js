var config = require('./config');

var newrelic;
if (config.NEW_RELIC_LICENSE_KEY) {
  console.log('Initializing newrelic...');
  newrelic = require('newrelic');
}

// App memory grows until dyno throws OOM errors.
// TODO: Replace this with GC config command-line flags
// Until then, stop the world every 30 seconds.
setInterval(function() {
 global.gc();
}, 30000);

// Koa deps
var app = require('koa')();
app.poweredBy = false;
app.proxy = true;
app.use(require('koa-static')('public'));
app.use(require('koa-static')('dist', { maxage: 1000 * 60 * 60 * 24 * 365 }));
app.use(require('koa-logger')());
app.use(require('koa-body')({
  // Max payload size allowed in request form body
  // Defaults to '56kb'
  formLimit: config.MAX_POST_LENGTH*2
}));
app.use(require('koa-methodoverride')('_method'));
var route = require('koa-route');
var views = require('koa-views');
// Node
var util = require('util');
var path = require('path');
var fs = require('co-fs');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:index');
var assert = require('better-assert');
var swig = require('swig');
var co = require('co');
var bunyan = require('bunyan');
var uuid = require('node-uuid');
var coParallel = require('co-parallel');
// 1st party
var db = require('./db');
var pre = require('./presenters');
var middleware = require('./middleware');
var cancan = require('./cancan');
var emailer = require('./emailer');
var log = require('./logger');
var cache = require('./cache')();
var belt = require('./belt');
var bbcode = require('./bbcode');
var welcomePm = require('./welcome_pm');

// Catch and log all errors that bubble up to koa
// app.on('error', function(err) {
//   log.error(err, 'Error');
//   console.error('Error:', err, err.stack);
// });

app.use(function*(next) {
  var start = Date.now();
  this.log = log.child({ req_id: uuid.v1() });  // time-based uuid
  this.log.info({ req: this.request }, '--> %s %s', this.method, this.path);
  yield next;
  var diff = Date.now() - start;
  this.log.info({ ms: diff, res: this.response },
                '<-- %s %s %s %s',
                this.method, this.path, this.status, diff + 'ms');
});

// Upon app boot, check for compiled assets
// in the `dist` folder. If found, attach their
// paths to the context so the view layer can render
// them.
//
// Example value of `dist`:
// { css: 'all-ab42cf1.css', js: 'all-d181a21.js' }'
var dist;
co(function*() {
  var manifest = {};
  var manifestPath = './dist/rev-manifest.json';
  if (yield fs.exists(manifestPath)) {
    var jsonString = yield fs.readFile(manifestPath, 'utf8');
    manifest = JSON.parse(jsonString);
  }
  dist = {
    css: manifest['all.css'],
    js: manifest['all.js']
  };
}).then(function() {
  console.log('dist set', dist);
  log.info({ dist: dist }, 'dist set');
}, function(err) {
  console.log('dist failed', dist);
  log.error(err, 'dist failed');
});

app.use(function*(next) {
  this.dist = dist;
  yield next;
});

// Expose config to view layer
app.use(function*(next) {
  this.config = config;
  yield next;
});

// TODO: Since app.proxy === true (we trust X-Proxy-* headers), we want to
// reject all requests that hit origin. app.proxy should only be turned on
// when app is behind trusted proxy like Cloudflare.

var valid = require('./validation');  // Load before koa-validate
app.use(require('koa-validate')());

////////////////////////////////////////////////////////////

app.use(middleware.currUser());
app.use(middleware.flash('flash'));
app.use(function*(next) {  // Must become before koa-router
  var ctx = this;
  this.can = cancan.can;
  this.assertAuthorized = function(user, action, target) {
    var canResult = cancan.can(user, action, target);
    ctx.log.info('[assertAuthorized] Can %s %s: %s',
                 (user && user.uname) || '<Guest>', action, canResult);
    ctx.assert(canResult, 403);
  };
  yield next;
});

// Custom Swig filters
////////////////////////////////////////////////////////////

// TODO: Extract custom swig filters
// {{ 'firetruck'|truncate(5) }}  -> 'firet...'
// {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
swig.setFilter('truncate', belt.makeTruncate('…'));

// Returns distance from now to date in days. 0 or more.
function daysAgo(date) {
  return Math.floor((Date.now() - date.getTime()) / (1000*60*60*24));
}
swig.setFilter('daysAgo', daysAgo);

// FIXME: Can't render bbcode on the fly until I speed up
// slow bbcode like tabs
swig.setFilter('bbcode', function(markup) {
  var html, start = Date.now();
  try {
    html = bbcode(markup);
    return html;
  } catch(ex) {
    //return 'There was a problem parsing a tag in this BBCode<br><br><pre style="overflow: auto">' + markup + '</pre>';
    throw ex;
  } finally {
    console.log('bbcode render time: ', Date.now() - start, 'ms - Rendered', markup.length, 'chars');
  }
});

// commafy(10) -> 10
// commafy(1000000) -> 1,000,000
function commafy(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
swig.setFilter('commafy', commafy);
swig.setFilter('formatDate', pre.formatDate);

////////////////////////////////////////////////////////////

// Configure templating system to use `swig`
// and to find view files in `view` directory
app.use(views('../views', {
  // Default extension is .html
  default: 'html',
  // consolidate bug hack
  cache: (config.NODE_ENV === 'development' ? false : 'memory'),
  map: { html: 'swig' }
}));

////////////////////////////////////////////////////////////
// Routes //////////////////////////////////////////////////
////////////////////////////////////////////////////////////

// TODO: Migrate from route to koa-router.
// For one, it lets koa-validate's checkParams work since it puts the params
// in the koa context
app.use(require('koa-router')(app));

app.get('/test', function*() {
  yield this.render('test', {
    ctx: this
  });
});

//
// Logout
//
app.use(route.post('/me/logout', function *() {
  if (this.currUser)
    yield db.logoutSession(this.currUser.id, this.cookies.get('sessionId'));
  this.flash = { message: ['success', 'Session terminated'] };
  this.redirect('/');
}));

//
// Login form
//
app.use(route.get('/login', function*() {
  yield this.render('login', {
    ctx: this,
    title: 'Login'
  });
}));

//
// Create new user
// - uname
// - password1
// - password2
// - email
// - g-recaptcha-response

app.post('/users', function*() {
  this.log.info({ body: this.request.body }, 'Submitting registration creds');

  // Validation

  this.checkBody('uname')
    .notEmpty()
    .trim()
    .isLength(config.MIN_UNAME_LENGTH,
              config.MAX_UNAME_LENGTH,
              'Username must be ' + config.MIN_UNAME_LENGTH +
              '-' + config.MAX_UNAME_LENGTH + ' characters')
    .match(/^[a-z0-9 ]+$/i, 'Username must only contain a-z, 0-9, and spaces')
    .match(/[a-z]/i, 'Username must contain at least one letter (a-z)')
    .notMatch(/^[-]/, 'Username must not start with hyphens')
    .notMatch(/[-]$/, 'Username must not end with hyphens')
    .notMatch(/[ ]{2,}/, 'Username contains consecutive spaces');
  this.checkBody('email')
    .notEmpty('Email required')
    .trim()
    .isEmail('Email must be valid');
  this.checkBody('password2')
    .notEmpty('Password confirmation required');
  this.checkBody('password1')
    .notEmpty('Password required')
    .eq(this.request.body.password2, 'Password confirmation must match');
  this.checkBody('g-recaptcha-response')
    .notEmpty('You must attempt the human test');

  this.checkBody('uname')
    .assertNot(yield db.findUserByUname(this.request.body.uname),
               'Username taken',
               true);
  this.checkBody('email')
    .assertNot(yield db.findUserByEmail(this.request.body.email),
               'Email taken',
               true);

  // Bail if any validation errs
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('/register');
    return;
  }

  // Check recaptcha against google
  var passedRecaptcha = yield belt.makeRecaptchaRequest({
    userResponse: this.request.body['g-recaptcha-response'],
    userIp: this.request.ip
  });
  if (! passedRecaptcha) {
    debug('Google rejected recaptcha');
    this.flash = {
      message: ['danger', 'You failed the recaptcha challenge'],
      params: unvalidatedParams
    };
    return this.response.redirect('/register');
  }

  // User params validated, so create a user and log them in
  var result, errMessage;
  try {
    result = yield db.createUserWithSession({
      uname: this.request.body.uname,
      email: this.request.body.email,
      password: this.request.body.password1,
      ipAddress: this.request.ip
    });
  } catch(ex) {
    if (_.isString(ex))
      switch(ex) {
        case 'UNAME_TAKEN':
          errMessage = 'Username is taken';
          break;
        case 'EMAIL_TAKEN':
          errMessage = 'Email is taken';
          break;
      }
    else
      throw ex;
  }

  if (errMessage) {
    this.flash = {
      message: ['danger', errMessage],
      params: this.request.body
    };
    return this.response.redirect('/register');
  }

  var user = result['user'];
  var session = result['session'];

  // Log in the user
  this.cookies.set('sessionId', session.id, {
    expires: belt.futureDate(new Date(), { years: 1 })
  });

  // Send user the introductory PM

  if (config.STAFF_REPRESENTATIVE_ID) {
    yield db.createConvo({
      userId: config.STAFF_REPRESENTATIVE_ID,
      toUserIds: [user.id],
      title: 'RPGuild Welcome Package',
      markup: welcomePm.markup,
      html: welcomePm.html
    });
  }

  this.flash = { message: ['success', 'Registered successfully'] };
  return this.response.redirect('/');
});

//
// Create session
//
app.post('/sessions', function*() {
  this.checkBody('uname-or-email').notEmpty();
  this.checkBody('password').notEmpty();
  this.checkBody('remember-me').toBoolean();

  if (this.errors) {
    this.flash = { message: ['danger', 'Invalid creds'] };
    this.response.redirect('/login');
    return;
  }

  var unameOrEmail = this.request.body['uname-or-email'];
  var password = this.request.body.password;
  var rememberMe = this.request.body['remember-me'];

  // Check if user with this uname or email exists
  var user = yield db.findUserByUnameOrEmail(unameOrEmail);
  if (!user) {
    this.log.info('Invalid creds');
    this.flash = { message: ['danger', 'Invalid creds'] };
    this.response.redirect('/login');
    return;
  }

  // Check if provided password matches digest
  if (! (yield belt.checkPassword(password, user.digest))) {
    this.log.info('Invalid creds');
    this.flash = { message: ['danger', 'Invalid creds'] };
    this.response.redirect('/login');
    return;
  }

  // User authenticated
  var interval = (rememberMe ? '1 year' : '1 day');
  var session = yield db.createSession({
    userId: user.id,
    ipAddress: this.request.ip,
    interval: interval
  });

  this.log.info({ session: session, session_interval: interval },
                'Created session');
  this.cookies.set('sessionId', session.id, {
    expires: belt.futureDate(new Date(), rememberMe ? { years: 1 } : { days: 1 })
  });
  this.flash = { message: ['success', 'Logged in successfully'] };
  this.response.redirect('/');
});

//
// Show users
//
app.get('/users', function*() {
  yield this.render('users', {
    ctx: this
  });
});

//
// BBCode Cheatsheet
//
app.get('/bbcode', function*() {
  yield this.render('bbcode_cheatsheet', {
    ctx: this,
    title: 'BBCode Cheatsheet'
  });
});

//
// Registration form
//
app.get('/register', function*() {
  assert(config.RECAPTCHA_SITEKEY);
  assert(config.RECAPTCHA_SITESECRET);
  yield this.render('register', {
    ctx: this,
    recaptchaSitekey: config.RECAPTCHA_SITEKEY,
    title: 'Register'
  });
});

//
// Homepage
//
app.use(route.get('/', function*() {
  var categories = yield db.findCategories();
  // We don't show the mod forum on the homepage.
  // Nasty, but just delete it for now
  // TODO: Abstract
  _.remove(categories, { id: 4 });
  var categoryIds = _.pluck(categories, 'id');
  var allForums = yield db.findForums(categoryIds);
  var topLevelForums = _.reject(allForums, 'parent_forum_id');
  var childForums = _.filter(allForums, 'parent_forum_id');
  // Map of {CategoryId: [Forums...]}
  childForums.forEach(function(childForum) {
    var parentIdx = _.findIndex(topLevelForums, { id: childForum.parent_forum_id });
    if (_.isArray(topLevelForums[parentIdx].forums))
      topLevelForums[parentIdx].forums.push(childForum);
    else
      topLevelForums[parentIdx].forums = [childForum];
  });
  var groupedTopLevelForums = _.groupBy(topLevelForums, 'category_id');
  categories = categories.map(function(category) {
    category.forums = (groupedTopLevelForums[category.id] || []).map(pre.presentForum);
    return category;
  });

  // Get stats
  var stats = cache.get('stats');
  stats.onlineUsers = stats.onlineUsers.map(pre.presentUser);
  if (stats.latestUser)
    stats.latestUser = pre.presentUser(stats.latestUser);

  yield this.render('homepage', {
    ctx: this,
    categories: categories,
    stats: stats
  });
}));

//
// Remove subcription
//
app.delete('/me/subscriptions/:topicSlug', function*() {
  var topicId = belt.extractId(this.params.topicSlug);
  this.assert(topicId, 404);

  this.assert(this.currUser, 404);
  var topic = yield db.findTopic(topicId);
  this.assertAuthorized(this.currUser, 'UNSUBSCRIBE_TOPIC', topic);
  yield db.unsubscribeFromTopic(this.currUser.id, topicId);
  // TODO: flash
  topic = pre.presentTopic(topic);

  if (this.request.body['return-to-topic'])
    return this.response.redirect(topic.url);

  this.response.redirect('/me/subscriptions');
});

//
// Forgot password page
//
app.use(route.get('/forgot', function*() {
  if (!config.IS_EMAIL_CONFIGURED)
    return this.body = 'This feature is currently disabled';
  yield this.render('forgot', {
    ctx: this,
    title: 'Forgot Password'
  });
}));

//
//
// - Required param: email
app.use(route.post('/forgot', function*() {
  if (!config.IS_EMAIL_CONFIGURED)
    return this.body = 'This feature is currently disabled';

  var email = this.request.body.email;
  if (!email) {
    this.flash = { message: ['danger', 'You must provide an email']};
    this.response.redirect('/forgot');
    return;
  }
  // Check if it belongs to a user
  var user = yield db.findUserByEmail(email);

  // Always send the same message on success and failure.
  var successMessage = 'Check your email';

  // Don't let the user know if the email belongs to anyone.
  // Always look like a success
  if (!user) {
    this.log.info('User not found with email: %s', email);
    this.flash = { message: ['success', successMessage]};
    this.response.redirect('/');
    return;
  }

  // Don't send another email until previous reset token has expired
  if (yield db.findLatestActiveResetToken(user.id)) {
    this.log.info('User already has an active reset token');
    this.flash = { message: ['success', successMessage] };
    this.response.redirect('/');
    return;
  }

  var resetToken = yield db.createResetToken(user.id);
  this.log.info({ resetToken: resetToken }, 'Created reset token');
  // Send email in background
  this.log.info('Sending email to %s', user.email);
  emailer.sendResetTokenEmail(user.uname, user.email, resetToken.token);

  this.flash = { message: ['success', successMessage] };
  this.response.redirect('/');
}));

// Password reset form
// - This form allows a user to enter a reset token and new password
// - The email from /forgot will link the user here
app.use(route.get('/reset-password', function*() {
  if (!config.IS_EMAIL_CONFIGURED)
    return this.body = 'This feature is currently disabled';
  var resetToken = this.request.query.token;
  yield this.render('reset_password', {
    ctx: this,
    resetToken: resetToken,
    title: 'Reset Password with Token'
  });
}));

// Params
// - token
// - password1
// - password2
app.use(route.post('/reset-password', function*() {
  if (!config.IS_EMAIL_CONFIGURED)
    return this.body = 'This feature is currently disabled';
  var token = this.request.body.token;
  var password1 = this.request.body.password1;
  var password2 = this.request.body.password2;
  this.checkBody('remember-me').optional().toBoolean();
  var rememberMe = this.request.body['remember-me'];

  // Check passwords
  if (password1 !== password2) {
    this.flash = {
      message: ['danger', 'Your new password and the new password confirmation must match'],
      params: { token: token }
    };
    return this.response.redirect('/reset-password?token=' + token);
  }

  // Check reset token
  var user = yield db.findUserByResetToken(token);

  if (!user) {
    this.flash = {
      message: ['danger', 'Invalid reset token. Either you typed the token in wrong or the token expired.']
    };
    return this.response.redirect('/reset-password?token=' + token);
  }

  // Reset token and passwords were valid, so update user password
  yield db.updateUserPassword(user.id, password1);

  // Delete user's reset tokens - They're for one-time use
  yield db.deleteResetTokens(user.id);

  // Log the user in
  var interval = rememberMe ? '1 year' : '1 day';
  var session = yield db.createSession({
    userId: user.id,
    ipAddress: this.request.ip,
    interval: interval
  });
  this.cookies.set('sessionId', session.id, {
    expires: belt.futureDate(new Date(), rememberMe ? { years : 1 } : { days: 1 })
  });

  this.flash = { message: ['success', 'Your password was updated'] };
  return this.response.redirect('/');
}));

//
// Create subscription
//
// Body params:
// - topic-id
app.post('/me/subscriptions', function*() {
  this.assert(this.currUser, 404);

  // Ensure user doesn't have 100 subscriptions
  var subs = yield db.findSubscribedTopicsForUserId(this.currUser.id);
  if (subs.length >= 100)
    return this.body = 'You cannot have more than 100 topic subscriptions';

  var topicId = this.request.body['topic-id'];
  this.assert(topicId, 404);
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'SUBSCRIBE_TOPIC', topic);
  // TODO: flash
  yield db.subscribeToTopic(this.currUser.id, topicId);

  topic = pre.presentTopic(topic);

  if (this.request.body['return-to-topic'])
    return this.response.redirect(topic.url);

  this.response.redirect('/me/subscriptions');
});

//
// Edit user
//
app.get('/users/:slug/edit', function*() {
  this.assert(this.currUser, 404);
  var user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);
  user = pre.presentUser(user);
  yield this.render('edit_user', {
    ctx: this,
    user: user,
    title: 'Edit User: ' + user.uname
  });
});

//// TODO: DRY up all of these individual PUT routes
//// While I like the simplicity of individual logic per route,
//// it introduces syncing overhead between the implementations

//
// Update user role
//
app.put('/users/:slug/role', function*() {
  this.checkBody('role')
    .isIn(['banned', 'member', 'mod', 'smod', 'admin'], 'Invalid role');
  this.assert(!this.errors, 400, belt.joinErrors(this.errors));
  // TODO: Authorize role param against role of both parties
  var user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER_ROLE', user);
  yield db.updateUserRole(user.id, this.request.body.role);
  user = pre.presentUser(user);
  this.flash = { message: ['success', 'User role updated'] };
  this.response.redirect(user.url + '/edit');
});

// Delete legacy sig
app.delete('/users/:slug/legacy-sig', function*() {
  var user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);
  yield db.deleteLegacySig(user.id);
  this.flash = { message: ['success', 'Legacy sig deleted'] };
  this.response.redirect('/users/' + this.params.slug + '/edit');
});

// Change user's bio_markup via ajax
// Params:
// - markup: String
app.put('/api/users/:id/bio', function*() {
  // Validation markup
  this.checkBody('markup')
    .trim()
    //// FIXME: Why does isLength always fail despite the optional()?
    // .isLength(0, config.MAX_BIO_LENGTH,
    //           'Bio must be 0-' + config.MAX_BIO_LENGTH + ' chars');

  if (this.request.body.markup.length > config.MAX_BIO_LENGTH)
    this.errors.push('Bio must be 0-' + config.MAX_BIO_LENGTH + ' chars');

  // Return 400 with validation errors, if any
  this.assert(!this.errors, 400, belt.joinErrors(this.errors));

  var user = yield db.findUserById(this.params.id);
  this.assert(user, 404);

  // Ensure currUser has permission to update user
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);

  // Validation succeeded
  // Render markup to html
  var html = '';
  if (this.request.body.markup.length > 0)
    html = bbcode(this.request.body.markup);

  // Save markup and html
  var updatedUser = yield db.updateUserBio(
    user.id, this.request.body.markup, html
  );

  this.body = JSON.stringify(updatedUser);
});

//
// Update user
//
// This is a generic update route for updates that only need the
// UPDATE_USER cancan authorization check. In other words, this is
// a generic update route for updates that don't have complex logic
// or authorization checks
//
// At least one of these updates:
// - email
// - avatar-url
// - sig (which will pre-render sig_html field)
// - hide-sigs
// - is-ghost
app.put('/users/:slug', function*() {
  debug('BEFORE', this.request.body);

  this.checkBody('email')
    .optional()
    .isEmail('Invalid email address');
  this.checkBody('sig')
    .optional()
  this.checkBody('avatar-url')
    .optional()
  if (this.request.body['avatar-url'] && this.request.body['avatar-url'].length > 0)
    this.checkBody('avatar-url')
      .trim()
      .isUrl('Must specify a URL for the avatar');
  // Coerce checkboxes to bool only if they are defined
  if (!_.isUndefined(this.request.body['hide-sigs']))
    this.checkBody('hide-sigs').toBoolean();
  if (!_.isUndefined(this.request.body['is-ghost']))
    this.checkBody('is-ghost').toBoolean();

  debug('AFTER', this.request.body);

  if (this.errors) {
    this.flash = { message: ['danger', belt.joinErrors(this.errors)] }
    this.response.redirect(this.request.path + '/edit');
    return;
  }

  var user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);

  var sig_html;
  // User is only updating their sig if `sig` is a string.
  // If it's a blank string, then user is trying to clear their sig
  if (_.isString(this.request.body.sig))
    if (this.request.body.sig.trim().length > 0)
      sig_html = bbcode(this.request.body.sig);
    else
      sig_html = '';

  yield db.updateUser(user.id, {
    email: this.request.body.email || user.email,
    sig: this.request.body.sig,
    sig_html: sig_html,
    avatar_url: this.request.body['avatar-url'],
    hide_sigs: _.isBoolean(this.request.body['hide-sigs'])
                 ? this.request.body['hide-sigs']
                 : user.hide_sigs,
    is_ghost: _.isBoolean(this.request.body['is-ghost'])
                ? this.request.body['is-ghost']
                : user.is_ghost
  });
  user = pre.presentUser(user);
  this.flash = { message: ['success', 'User updated'] };
  this.response.redirect(user.url + '/edit');
});

//
// Show subscriptions
//
app.get('/me/subscriptions', function*() {
  this.assert(this.currUser, 404);
  var topics = yield db.findSubscribedTopicsForUserId(this.currUser.id);
  topics = topics.map(pre.presentTopic);
  var grouped = _.groupBy(topics, function(topic) {
    return topic.forum.is_roleplay;
  });
  var roleplayTopics = grouped[true] || [];
  var nonroleplayTopics = grouped[false] || [];
  yield this.render('subscriptions', {
    ctx: this,
    topics: topics,
    roleplayTopics: roleplayTopics,
    nonroleplayTopics: nonroleplayTopics,
    title: 'My Subscriptions'
  });
});

//
// Lexus lounge (Mod forum)
//
// The user that STAFF_REPRESENTATIVE_ID points to.
// Loaded once upon boot since env vars require reboot to update.
var staffRep;
app.get('/lexus-lounge', function*() {
  this.assertAuthorized(this.currUser, 'LEXUS_LOUNGE');
  if (!staffRep && config.STAFF_REPRESENTATIVE_ID) {
    staffRep = yield db.findUser(config.STAFF_REPRESENTATIVE_ID);
    staffRep = pre.presentUser(staffRep);
  }
  var category = yield db.findModCategory();
  var forums = yield db.findForums([category.id]);
  category.forums = forums;
  category = pre.presentCategory(category);
  var latestUserLimit = 50;
  var latestUsers = yield db.findLatestUsers(latestUserLimit);
  latestUsers = latestUsers.map(pre.presentUser);
  yield this.render('lexus_lounge', {
    ctx: this,
    category: category,
    latestUsers: latestUsers,
    latestUserLimit: latestUserLimit,
    title: 'Lexus Lounge — Mod Forum',
    staffRep: staffRep
  });
});

//
// Canonical show forum
//
app.get('/forums/:forumSlug', function*() {
  var forumId = belt.extractId(this.params.forumSlug);
  this.assert(forumId, 404);

  this.checkQuery('page').optional().toInt();
  this.assert(!this.errors, 400, belt.joinErrors(this.errors))

  var forum = yield db.findForum(forumId);
  this.assert(forum, 404);

  forum = pre.presentForum(forum);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(forum.id, forum.title);
  if (this.params.forumSlug !== expectedSlug) {
    this.response.redirect(forum.url + this.request.search);
    return;
  }

  this.assertAuthorized(this.currUser, 'READ_FORUM', forum);

  var pager = belt.calcPager(this.request.query.page, 25, forum.topics_count);

  var topics = yield db.findTopicsByForumId(forumId, pager.limit, pager.offset);
  forum.topics = topics;
  forum = pre.presentForum(forum);
  yield this.render('show_forum', {
    ctx: this,
    forum: forum,
    currPage: pager.currPage,
    totalPages: pager.totalPages,
    title: forum.title
  });
});

//
// Create post
// Body params:
// - post-type
// - markup
//
app.post('/topics/:topicSlug/posts', function*() {
  var topicId = belt.extractId(this.params.topicSlug);
  this.assert(topicId, 404);

  this.checkBody('post-type').isIn(['ic', 'ooc', 'char'], 'Invalid post-type');
  this.checkBody('markup')
    .trim()
    .isLength(config.MIN_POST_LENGTH,
              config.MAX_POST_LENGTH,
              'Post must be between ' +
              config.MIN_POST_LENGTH + ' and ' +
              config.MAX_POST_LENGTH + ' chars long');

  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('back');
    return;
  }

  var postType = this.request.body['post-type'];
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'CREATE_POST', topic);

  // If non-rp forum, then the post must be 'ooc' type
  if (!topic.forum.is_roleplay)
    this.assert(postType === 'ooc', 400);

  // Render the bbcode
  var html = bbcode(this.request.body.markup);

  // TODO: Validation
  var post = yield db.createPost({
    userId: this.currUser.id,
    ipAddress: this.request.ip,
    topicId: topic.id,
    markup: this.request.body.markup,
    html: html,
    type: postType,
    isRoleplay: topic.forum.is_roleplay
  });
  post = pre.presentPost(post);
  this.response.redirect(post.url);
});

//
// Search users
//
app.get('/search/users', function*() {
  this.checkQuery('text').optional().toString(); // undefined || String
  this.checkQuery('before-id').optional().toInt();  // undefined || Number

  var usersList;
  if (this.query['before-id']) {
    if (this.query['text']) {
      //this.checkQuery('text').notEmpty().isLength(1, 15, 'Search text must be 1-15 chars');
      usersList = yield db.findUsersContainingStringWithId(this.query['text'], this.query['before-id']);
    }else {
      usersList = yield db.findAllUsersWithId(this.query['before-id']);
    }
  }else if (this.query['text']) {
    //this.checkQuery('text').notEmpty().isLength(1, 15, 'Search text must be 1-15 chars');
    usersList = yield db.findUsersContainingString(this.query['text']);
  }else {
    usersList = yield db.findAllUsers();
  }

  if (this.errors) {
  this.flash = {
    message: ['danger', belt.joinErrors(this.errors)],
    params: this.request.body
  };
  this.response.redirect('/search/users');
  return;
  }

  var nextBeforeId = _.last(usersList) != null ? _.last(usersList).id : null;

  yield this.render('search_users', {
    ctx: this,
    term: this.query['text'],
    title: 'Search Users',
    usersList: usersList,
    // Pagination
    beforeId: this.query['before-id'],
    nextBeforeId: nextBeforeId,
    usersPerPage: config.USERS_PER_PAGE
  });
});

//
// Show convos
//
app.get('/me/convos', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.checkQuery('before-id').optional().toInt();  // undefined || Number

  this.assert(this.currUser, 404);
  var convos = yield db.findConvosInvolvingUserId(this.currUser.id,
                                                  this.query['before-id']);
  convos = convos.map(pre.presentConvo);
  var nextBeforeId = convos.length > 0 ? _.last(convos).latest_pm_id : null;
  yield this.render('me_convos.html', {
    ctx: this,
    convos: convos,
    title: 'My Private Conversations',
    // Pagination
    beforeId: this.query['before-id'],
    nextBeforeId: nextBeforeId,
    perPage: config.CONVOS_PER_PAGE
  });
});

//
// Show user
//
// Legacy URLs look like /users/42
// We want to redirect those URLs to /users/some-username
// The purpose of this effort is to not break old URLs, but rather
// redirect them to the new URLs
app.get('/users/:userIdOrSlug', function*() {
  // If param is all numbers, then assume it's a user-id.
  // Note: There are some users in the database with only digits in their name
  // which is not possible anymore since unames require at least one a-z letter.
  var user;
  if (/^\d+$/.test(this.params.userIdOrSlug)) {
    user = yield db.findUser(this.params.userIdOrSlug);
    this.assert(user, 404);
    this.response.redirect('/users/' + user.slug);
    return;
  }

  this.checkQuery('before-id').optional().toInt();  // will be undefined or number
  var userId = this.params.userIdOrSlug;
  var user = yield db.findUserBySlug(userId);
  // Ensure user exists
  this.assert(user, 404);
  user = pre.presentUser(user);
  // OPTIMIZE: Merge into single query?
  var recentPosts = yield db.findRecentPostsForUserId(user.id,
                                                      this.query['before-id']);
  // TODO: Figure out how to do this so I'm not possibly serving empty or
  //       partial pages since they're being filtered post-query.
  // Filter out posts that currUser is unauthorized to see
  recentPosts = recentPosts.filter(function(post) {
    return cancan.can(this.currUser, 'READ_POST', post);
  }.bind(this));
  recentPosts = recentPosts.map(pre.presentPost);

  // The ?before-id=_ of the "Next" button. i.e. the lowest
  // id of the posts on the current page
  var nextBeforeId = recentPosts.length > 0 ? _.last(recentPosts).id : null;

  yield this.render('show_user', {
    ctx: this,
    user: user,
    recentPosts: recentPosts,
    title: 'User: ' + user.uname,
    // Pagination
    nextBeforeId: nextBeforeId,
    recentPostsPerPage: config.RECENT_POSTS_PER_PAGE
  });
});

app.get('/showthread.php', function*() {
  this.flash = {
    message: ['info', 'Sorry, that page does not exist anymore.']
  };
  this.response.redirect('/');
});

app.get('/printthread.php', function*() {
  this.flash = {
    message: ['info', 'Sorry, that page does not exist anymore.']
  };
  this.response.redirect('/');
});

app.get('/private.php', function*() {
  this.flash = {
    message: ['info', 'Sorry, that page does not exist anymore.']
  };
  this.response.redirect('/');
});

//
// Delete user
//
app.delete('/users/:id', function*() {
  var user = yield db.findUser(this.params.id);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'DELETE_USER', user);
  yield db.deleteUser(this.params.id);

  this.flash = {
    message: ['success', util.format('User deleted along with %d posts and %d PMs',
                                     user.posts_count, user.pms_count)]
  };
  this.response.redirect('/');
});

//
// Create convo
// Params:
// - 'to': Comma-delimited string of unames user wants to send to
// - 'title'
// - 'markup'
//
app.use(route.post('/convos', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  var ctx = this;
  this.assertAuthorized(this.currUser, 'CREATE_CONVO');

  // Light input validation
  this.checkBody('title').isLength(config.MIN_TOPIC_TITLE_LENGTH,
                                   config.MAX_TOPIC_TITLE_LENGTH,
                                   'Title required');
  this.checkBody('markup').isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH,
                                  'Post text must be ' + config.MIN_POST_LENGTH +
                                  '-' + config.MAX_POST_LENGTH + ' chars long');

  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('/convos/new');
    return;
  }

  // TODO: Validation, Error msgs, preserve params
  // TODO: Sponge this up into a fixer+validater

  var unames = this.request.body.to && this.request.body.to.split(',') || [];
  var title = this.request.body.title;
  var markup = this.request.body.markup;
  // Remove empty (Note: unames contains lowercase unames)
  unames = _.compact(unames.map(function(uname) {
    return uname.trim().toLowerCase();
  }));
  // Ensure no more than 5 unames specified
  if (unames.length > 5) return this.body = 'You cannot send a PM to more than 5 people at once';
  // Ensure user didn't specify themself
  unames = _.reject(unames, function(uname) {
    return uname === ctx.currUser.uname.toLowerCase();
  });
  // Remove duplicates
  unames = _.uniq(unames);
  // Ensure they are all real users
  var users = yield db.findUsersByUnames(unames);

  // If not all unames resolved into users, then we return user to form
  // to fix it.
  if (users.length !== unames.length) {
    var rejectedUnames = _.difference(unames, users.map(function(user) {
      return user.uname.toLowerCase();
    }));
    this.flash = {
      message: [
        'danger',
        'No users were found with these names: ' + rejectedUnames.join(', ')
      ]
    };
    this.response.redirect('/convos/new?to=' + unames.join(','));
    return;
  }

  // Render bbcode
  var html = bbcode(markup);

  // If all unames are valid, then we can create a convo
  var toUserIds = _.pluck(users, 'id');
  var convo = yield db.createConvo({
    userId: this.currUser.id,
    toUserIds: toUserIds,
    title: title,
    markup: markup,
    html: html,
    ipAddress: this.request.ip
  });
  convo = pre.presentConvo(convo);

  // Create CONVO notification for each recipient
  yield coParallel(toUserIds.map(function*(toUserId) {
    yield db.createConvoNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: toUserId,
      convo_id: convo.id
    });
  }), 5);

  this.response.redirect(convo.url);
}));

//
// New Convo
//
// TODO: Implement typeahead
app.use(route.get('/convos/new', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assertAuthorized(this.currUser, 'CREATE_CONVO');
  // TODO: Validation, Error msgs, preserve params
  yield this.render('new_convo', {
    ctx: this,
    to: this.request.query.to,
    title: 'New Conversation'
  });
}));

//
// Create PM
// Body params
// - markup
//
app.post('/convos/:convoId/pms', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  var ctx = this;

  this.assert(this.currUser, 403);
  this.checkBody('markup')
    .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);

  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('/convos/' + this.params.convoId);
    return;
  }

  var convo = yield db.findConvo(this.params.convoId);
  this.assert(convo, 404);
  this.assertAuthorized(this.currUser, 'CREATE_PM', convo);

  // Render bbcode
  var html = bbcode(this.request.body.markup);

  var pm = yield db.createPm({
    userId: this.currUser.id,
    ipAddress: this.request.ip,
    convoId: this.params.convoId,
    markup: this.request.body.markup,
    html: html
  });
  pm = pre.presentPm(pm);

  // Get only userIds of the *other* participants
  // Don't want to create notification for ourself
  var toUserIds = (yield db.findParticipantIds(this.params.convoId)).filter(function(userId) {
    return userId !== ctx.currUser.id;
  });

  // Upsert notifications table
  // TODO: config.MAX_CONVO_PARTICIPANTS instead of hard-coded 5
  yield coParallel(toUserIds.map(function*(toUserId) {
    yield db.createPmNotification({
      from_user_id: ctx.currUser.id,
      to_user_id: toUserId,
      convo_id: ctx.params.convoId
    });
  }), 5);

  this.response.redirect(pm.url);
});

//
// Show convo
//
app.use(route.get('/convos/:convoId', function*(convoId) {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 404);
  var convo = yield db.findConvo(convoId);
  this.assert(convo, 404);
  this.assertAuthorized(this.currUser, 'READ_CONVO', convo);
  this.checkQuery('page').optional().toInt();
  this.assert(!this.errors, 400, belt.joinErrors(this.errors));

  // If ?page=1 was given, then redirect without param
  // since page 1 is already the canonical destination of a convo url
  if (this.request.query.page === 1)
    return this.response.redirect(this.request.path);

  var page = Math.max(1, this.request.query.page || 1);
  var totalItems = convo.pms_count;
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl = page === 1 ? this.request.path :
                                   this.request.path + '?page=' + totalPages;
    return this.response.redirect(redirectUrl);
  }

  // 0 or 1
  var count = yield db.deleteConvoNotification(this.currUser.id, convoId);

  // Update the stale user's counts so that the notification count is reduced
  // appropriately when the page loads. Otherwise, the counts won't be updated
  // til next request.
  this.currUser.notifications_count -= count;
  this.currUser.convo_notifications_count -= count;

  var pms = yield db.findPmsByConvoId(convoId, page);
  convo.pms = pms;
  convo = pre.presentConvo(convo);
  yield this.render('show_convo', {
    ctx: this,
    convo: convo,
    title: 'Convo: ' + convo.title,
    // Pagination
    currPage: page,
    totalPages: totalPages
  });
}));

// Delete all notifications
app.delete('/me/notifications', function*() {
  // Ensure a user is logged in
  this.assert(this.currUser, 404);
  yield db.clearNotifications(this.currUser.id);
  this.flash = {
    message: ['success', 'Notifications cleared']
  };
  var redirectTo = this.request.body['redirect-to'] || '/';
  this.response.redirect(redirectTo);
});

// Delete only convo notifications
app.delete('/me/notifications/convos', function*() {
  // Ensure a user is logged in
  this.assert(this.currUser, 404);
  yield db.clearConvoNotifications(this.currUser.id);
  this.flash = {
    message: ['success', 'PM notifications cleared']
  };
  this.response.redirect('/me/convos');
});

//
// Create topic
//
// Body params:
// - forum-id
// - title
// - markup
//
app.post('/forums/:slug/topics', function*() {
  var forumId = belt.extractId(this.params.slug);
  this.assert(forumId, 404);

  // Ensure user is logged in
  this.assert(this.currUser, 403);

  // Load forum
  var forum = yield db.findForumById(forumId);

  // Ensure forum exists
  this.assert(forum, 404);
  forum = pre.presentForum(forum);

  // Check user authorization
  this.assertAuthorized(this.currUser, 'CREATE_TOPIC', forum);

  // Validate params

  this.checkBody('title')
    .notEmpty('Title is required')
    .isLength(config.MIN_TOPIC_TITLE_LENGTH,
              config.MAX_TOPIC_TITLE_LENGTH,
              'Title must be between ' +
              config.MIN_TOPIC_TITLE_LENGTH + ' and ' +
              config.MAX_TOPIC_TITLE_LENGTH + ' chars');
  this.checkBody('markup')
    .notEmpty('Post is required')
    .isLength(config.MIN_POST_LENGTH,
              config.MAX_POST_LENGTH,
              'Post must be between ' +
              config.MIN_POST_LENGTH + ' and ' +
              config.MAX_POST_LENGTH + ' chars');
  this.checkBody('forum-id')
    .notEmpty()
    .toInt();

  if (forum.is_roleplay)
    this.checkBody('post-type')
      .notEmpty()
      .toLowercase()
      .isIn(['ooc', 'ic'], 'post-type must be "ooc" or "ic"')

  // Validation failure

  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect(forum.url);
    return;
  }

  // Validation succeeded

  // Render BBCode to html
  var html = bbcode(this.request.body.markup);

  // post-type is always ooc for non-RPs
  var postType = forum.is_roleplay ? this.request.body['post-type'] : 'ooc';

  // Create topic
  var topic = yield db.createTopic({
    userId: this.currUser.id,
    forumId: forumId,
    ipAddress: this.request.ip,
    title: this.request.body.title,
    markup: this.request.body.markup,
    html: html,
    postType: postType,
    isRoleplay: forum.is_roleplay
  });
  topic = pre.presentTopic(topic);
  this.response.redirect(topic.url);
});

// Edit post form
// - The "Edit" button on posts links here so that people without
// javascript or poor support for javascript will land on a basic edit-post
// form that does not depend on javascript.
app.get('/posts/:id/edit', function*() {
  // Short-circuit if user isn't logged in
  this.assert(this.currUser, 403);

  // Load the post
  var post = yield db.findPostById(this.params.id);

  // 404 if it doesn't exist
  this.assert(post, 404);
  post = pre.presentPost(post);

  // Ensure current user is authorized to edit the post
  this.assertAuthorized(this.currUser, 'UPDATE_POST', post);

  yield this.render('edit_post', {
    ctx: this,
    post: post
  });
});

// See and keep in sync with GET /posts/:id/edit
app.get('/pms/:id/edit', function*() {
  // Short-circuit if user isn't logged in
  this.assert(this.currUser, 403);

  // Load the resource
  var pm = yield db.findPmById(this.params.id);

  // 404 if it doesn't exist
  this.assert(pm, 404);
  pm = pre.presentPm(pm);

  // Ensure current user is authorized to edit it
  this.assertAuthorized(this.currUser, 'UPDATE_PM', pm);

  yield this.render('edit_pm', {
    ctx: this,
    pm: pm
  });
});

//
// Update post markup (via from submission)
// This is for the /posts/:id/edit basic form made
// for people on devices where the Edit button doesn't work.
//
// Params: markup
app.put('/posts/:id', function*() {
  this.checkBody('markup').isLength(config.MIN_POST_LENGTH,
                                    config.MAX_POST_LENGTH);
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect(this.request.path + '/edit');
    return;
  }

  var post = yield db.findPostById(this.params.id);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_POST', post)

  // Render BBCode to html
  var html = bbcode(this.request.body.markup);

  var updatedPost = yield db.updatePost(this.params.id, this.request.body.markup, html);
  updatedPost = pre.presentPost(updatedPost);

  this.response.redirect(updatedPost.url);
});

// See and keep in sync with PUT /posts/:id
// Params: markup
app.put('/pms/:id', function*() {
  this.checkBody('markup').isLength(config.MIN_POST_LENGTH,
                                    config.MAX_POST_LENGTH);
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect(this.request.path + '/edit');
    return;
  }

  var pm = yield db.findPmById(this.params.id);
  this.assert(pm, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_PM', pm)

  // Render BBCode to html
  var html = bbcode(this.request.body.markup);

  var updatedPm = yield db.updatePm(this.params.id, this.request.body.markup, html);
  updatedPm = pre.presentPm(updatedPm);

  this.response.redirect(updatedPm.url);
});

//
// Post markdown view
//
// Returns the unformatted post source.
//
app.get('/posts/:id/raw', function*() {
  var post = yield db.findPostWithTopicAndForum(this.params.id);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser, 'READ_POST', post);
  this.set('Cache-Control', 'no-cache');
  this.body = post.markup ? post.markup : post.text;
});

app.get('/pms/:id/raw', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 404);
  var pm = yield db.findPmWithConvo(this.params.id);
  this.assert(pm, 404);
  this.assertAuthorized(this.currUser, 'READ_PM', pm);
  this.set('Cache-Control', 'no-cache');
  this.body = pm.markup ? pm.markup : pm.text;
});

//
// Update post markup
// Body params:
// - markup
//
// Keep /api/posts/:postId and /api/pms/:pmId in sync
app.put('/api/posts/:id', function*() {
  this.checkBody('markup').isLength(config.MIN_POST_LENGTH,
                                    config.MAX_POST_LENGTH);
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('back');
    return;
  }

  var post = yield db.findPost(this.params.id);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_POST', post)

  // Render BBCode to html
  var html = bbcode(this.request.body.markup);

  var updatedPost = yield db.updatePost(this.params.id, this.request.body.markup, html);
  updatedPost = pre.presentPost(updatedPost);
  this.body = JSON.stringify(updatedPost);
});

app.put('/api/pms/:id', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.checkBody('markup').isLength(config.MIN_POST_LENGTH,
                                    config.MAX_POST_LENGTH);
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('back');
    return;
  }

  // Users that aren't logged in can't read any PMs, so just short-circuit
  // if user is a guest so we don't even incur DB query.
  this.assert(this.currUser, 404);

  var pm = yield db.findPmWithConvo(this.params.id);

  // 404 if there is no PM with this ID
  this.assert(pm, 404);

  // Ensure user is allowed to update this PM
  this.assertAuthorized(this.currUser, 'UPDATE_PM', pm)

  // Render BBCode to html
  var html = bbcode(this.request.body.markup);

  var updatedPm = yield db.updatePm(this.params.id, this.request.body.markup, html);
  updatedPm = pre.presentPm(updatedPm);
  console.log('updatedPm', updatedPm);

  this.body = JSON.stringify(updatedPm);
});

//
// Update topic status
// Params
// - status (Required) String, one of STATUS_WHITELIST
//
app.put('/topics/:topicSlug/status', function*() {
  var topicId = belt.extractId(this.params.topicSlug);
  this.assert(topicId, 404);
  var STATUS_WHITELIST = ['stick', 'unstick', 'hide', 'unhide', 'close', 'open'];
  var status = this.request.body.status;
  this.assert(_.contains(STATUS_WHITELIST, status), 400, 'Invalid status');
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  var action = status.toUpperCase() + '_TOPIC';
  this.assertAuthorized(this.currUser, action, topic);
  yield db.updateTopicStatus(topicId, status);
  this.flash = { message: ['success', 'Topic updated'] };
  topic = pre.presentTopic(topic);
  this.response.redirect(topic.url);
});

// Update post state
app.post('/posts/:postId/:status', function*() {
  var STATUS_WHITELIST = ['hide', 'unhide'];
  this.assert(_.contains(STATUS_WHITELIST, this.params.status), 400,
              'Invalid status');
  this.assert(this.currUser, 403);
  var post = yield db.findPost(this.params.postId);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser,
                        this.params.status.toUpperCase() + '_POST',
                        post);
  var updatedPost = yield db.updatePostStatus(this.params.postId,
                                              this.params.status);
  updatedPost = pre.presentPost(updatedPost);

  this.response.redirect(updatedPost.url);
});

//
// Post permalink
// (Show post)
//
// Calculates pagination offset and redirects to
// canonical topic page since the page a post falls on depends on
// currUser. For example, members can't see most hidden posts while
// mods can.
// - Keep this in sync with /pms/:pmId
//
app.get('/posts/:postId', function*() {
  var post = yield db.findPostWithTopicAndForum(this.params.postId);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser, 'READ_POST', post);
  post = pre.presentPost(post);

  // Determine the topic url and page for this post
  var redirectUrl;
  if (post.idx < config.POSTS_PER_PAGE)
    redirectUrl = post.topic.url + '/' + post.type + '#post-' + post.id
  else
    redirectUrl = post.topic.url + '/' + post.type +
                  '?page=' +
                  Math.ceil((post.idx + 1) / config.POSTS_PER_PAGE) +
                  '#post-' + post.id;
  this.response.redirect(redirectUrl);
});

// PM permalink
// Keep this in sync with /posts/:postId
app.get('/pms/:id', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 404);
  var id = this.params.id;
  var pm = yield db.findPmWithConvo(id);
  this.assert(pm, 404);
  this.assertAuthorized(this.currUser, 'READ_PM', pm);

  pm = pre.presentPm(pm);

  var redirectUrl;
  if (pm.idx < config.POSTS_PER_PAGE)
    redirectUrl = pm.convo.url + '#post-' + pm.id
  else
    redirectUrl = pm.convo.url + '?page=' +
                  Math.max(1, Math.ceil((pm.idx + 1) / config.POSTS_PER_PAGE)) +
                  '#post-' + pm.id;
  this.response.redirect(redirectUrl);
});

//
// Canonical show topic
//

app.get('/topics/:slug/:postType', function*() {
  this.assert(_.contains(['ic', 'ooc', 'char'], this.params.postType), 404);
  this.checkQuery('page').optional().toInt();
  this.assert(!this.errors, 400, belt.joinErrors(this.errors))
  var topicId = belt.extractId(this.params.slug);
  this.assert(topicId, 404);

  // If ?page=1 was given, then redirect without param
  // since page 1 is already the canonical destination of a topic url
  if (this.request.query.page === 1)
    return this.response.redirect(this.request.path);

  var page = Math.max(1, this.request.query.page || 1);

  // Only incur the topic_subscriptions join if currUser exists
  var topic;
  if (this.currUser) {
    topic = yield db.findTopicWithIsSubscribed(this.currUser.id, topicId);
  } else {
    topic = yield db.findTopic(topicId);
  }
  this.assert(topic, 404);

  topic = pre.presentTopic(topic);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (this.params.slug !== expectedSlug) {
    this.response.redirect(topic.url + this.request.search);
    return;
  }

  // If user tried to go to ic/char tabs on a non-rp, then 404
  if (!topic.is_roleplay)
    this.assert(!_.contains(['ic', 'char'], this.params.postType), 404);

  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  var totalItems = topic[this.params.postType + '_posts_count'];
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Don't need this page when post pages are pre-calc'd in the database
  // var pager = belt.calcPager(page, config.POSTS_PER_PAGE, totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl = page === 1 ? this.request.path :
                                   this.request.path + '?page=' + totalPages;
    return this.response.redirect(redirectUrl);
  }

  var posts = yield db.findPostsByTopicId(topicId, this.params.postType, page);
  topic.posts = posts.map(pre.presentPost);
  yield this.render('show_topic', {
    ctx: this,
    topic: topic,
    postType: this.params.postType,
    title: 'Topic: ' + topic.title,
    // Pagination
    currPage: page,
    totalPages: totalPages
  });
});

// Legacy URL
// Redirect to the new, shorter topic URL
app.get('/topics/:topicId/posts/:postType', function*() {
  var redirectUrl = '/topics/' + this.params.topicId + '/' + this.params.postType;
  this.response.redirect(redirectUrl);
});

//
// Redirect topic to canonical url
//
// If roleplay (so guaranteed to have a OOC post OR a IC post)
//   If it has an IC post, go to IC tab
//   Else it must have an OOC post, so go to OOC tab
// Else it is a non-roleplay
//   Go to OOC tab
//
app.get('/topics/:slug', function*() {
  var topicId = belt.extractId(this.params.slug);
  this.assert(topicId, 404);

  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  topic = pre.presentTopic(topic);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (this.params.slug !== expectedSlug) {
    this.response.redirect(topic.url + this.request.search);
    return;
  }

  if (topic.forum.is_roleplay)
    if (topic.ic_posts_count > 0)
      this.response.redirect(this.request.path + '/ic');
    else
      this.response.redirect(this.request.path + '/ooc');
  else
    this.response.redirect(this.request.path + '/ooc');
});

//
// Staff list
//
// For now, just load staff upon first request, once per boot
var staffUsers;
app.get('/staff', function*() {
  if (!staffUsers)
    staffUsers = (yield db.findStaffUsers()).map(pre.presentUser);
  yield this.render('staff', {
    ctx: this,
    mods: _.filter(staffUsers, { role: 'mod' }),
    smods: _.filter(staffUsers, { role: 'smod' }),
    admins: _.filter(staffUsers, { role: 'admin' })
  });
});

app.listen(config.PORT);
console.log('Listening on ' + config.PORT);
