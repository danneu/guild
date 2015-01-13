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
app.use(require('koa-body')());
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
// 1st party
var db = require('./db');
var pre = require('./presenters');
var belt = require('./belt');
var middleware = require('./middleware');
var cancan = require('./cancan');
var emailer = require('./emailer');
var log = require('./logger');
var cache = require('./cache')(log);

// Catch and log all errors that bubble up to koa
app.on('error', function(err){
  log.error(err, 'Error');
});

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
// Exaple value of `dist`:
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
  log.info({ dist: dist }, 'dist set');
}, function(err) {
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
    ctx: this
  });
}));

//
// Register new user form
//
app.use(route.get('/register', function*() {
  assert(config.RECAPTCHA_SITEKEY);
  assert(config.RECAPTCHA_SITESECRET);
  yield this.render('register', {
    ctx: this,
    recaptchaSitekey: config.RECAPTCHA_SITEKEY
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
  this.cookies.set('sessionId', session.id);
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
  this.cookies.set('sessionId', session.id);
  this.flash = { message: ['success', 'Logged in successfully'] };
  this.response.redirect('/');
});

//
// Show users
//
app.use(route.get('/users', function*() {
  yield this.render('users', {
    ctx: this
  });
}));

//
// Registration form
//
app.use(route.get('/register', function*() {
  yield this.render('register', {
    ctx: this
  });
}));

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
app.use(route.delete('/me/subscriptions/:topicId', function*(topicId) {
  this.assert(this.currUser, 404);
  var topic = yield db.findTopic(topicId);
  this.assertAuthorized(this.currUser, 'SUBSCRIBE_TOPIC', topic);
  yield db.unsubscribeFromTopic(this.currUser.id, topicId);
  // TODO: flash
  topic = pre.presentTopic(topic);

  if (this.request.body['return-to-topic'])
    return this.response.redirect(topic.url);

  this.response.redirect('/me/subscriptions');
}));

//
// Forgot password page
//
app.use(route.get('/forgot', function*() {
  if (!config.IS_EMAIL_CONFIGURED)
    return this.body = 'This feature is currently disabled';
  yield this.render('forgot', {
    ctx: this
  });
}));

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
  var resetToken = this.request.query.token
  yield this.render('reset_password', {
    ctx: this,
    resetToken: resetToken
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
  var session = yield db.createSession({
    userId: user.id,
    ipAddress: this.request.ip,
    interval: '1 day'  // TODO: Add remember-me button to reset form?
  });
  this.cookies.set('sessionId', session.id);

  this.flash = { message: ['success', 'Your password was updated'] };
  return this.response.redirect('/');
}));

//
// Create subscription
//
// Body params:
// - topic-id
app.use(route.post('/me/subscriptions', function*() {
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
}));

//
// Edit user
//
app.get('/users/:userId/edit', function*() {
  this.assert(this.currUser, 404);
  var user = yield db.findUser(this.params.userId);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);
  user = pre.presentUser(user);
  yield this.render('edit_user', {
    ctx: this,
    user: user
  });
});

//// TODO: DRY up all of these individual PUT routes
//// While I like the simplicity of individual logic per route,
//// it introduces syncing overhead between the implementations

//
// Update user role
//
app.put('/users/:userId/role', function*() {
  this.checkBody('role').isIn(['banned', 'member', 'mod', 'smod', 'admin'],
                              'Invalid role');
  this.assert(!this.errors, 400, belt.joinErrors(this.errors));
  // TODO: Authorize role param against role of both parties
  var user = yield db.findUser(this.params.userId);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER_ROLE', user);
  yield db.updateUserRole(user.id, this.request.body.role);
  user = pre.presentUser(user);
  this.flash = { message: ['success', 'User role updated'] };
  this.response.redirect(user.url + '/edit');
});

// Delete legacy sig
app.delete('/users/:userId/legacy-sig', function*() {
  var user = db.findUser(this.params.userId);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);
  yield db.deleteLegacySig(this.params.userId);
  this.flash = { message: ['success', 'Legacy sig deleted'] };
  this.response.redirect('/users/' + this.params.userId + '/edit');
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
// - sig
// - hide-sigs
//
// TODO: This isn't very abstracted yet. Just an email endpoint for now.
//
app.put('/users/:userId', function*() {
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
  this.checkBody('hide-sigs')
    .optional()
    .toBoolean();

  if (this.errors) {
    this.flash = { message: ['danger', belt.joinErrors(this.errors)] }
    this.response.redirect(this.request.path + '/edit');
    return;
  }

  var user = yield db.findUser(this.params.userId);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);

  yield db.updateUser(user.id, {
    email: this.request.body.email || user.email,
    sig: this.request.body.sig,
    avatar_url: this.request.body['avatar-url'],
    hide_sigs: _.isBoolean(this.request.body['hide-sigs'])
                 ? this.request.body['hide-sigs']
                 : user.hide_sigs
  });
  user = pre.presentUser(user);
  this.flash = { message: ['success', 'User updated'] };
  this.response.redirect(user.url + '/edit');
});

//
// Show subscriptions
//
app.use(route.get('/me/subscriptions', function*() {
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
    nonroleplayTopics: nonroleplayTopics
  });
}));

//
// Lexus lounge (Mod forum)
//
app.use(route.get('/lexus-lounge', function*() {
  this.assertAuthorized(this.currUser, 'LEXUS_LOUNGE');
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
    latestUserLimit: latestUserLimit
  });
}));

//
// Canonical show forum
//
app.get('/forums/:forumId', function*() {
  this.checkQuery('page').optional().toInt();
  this.assert(!this.errors, 400, belt.joinErrors(this.errors))

  var forum = yield db.findForum(this.params.forumId);
  if (!forum) return;

  this.assertAuthorized(this.currUser, 'READ_FORUM', forum);

  var pager = belt.calcPager(this.request.query.page, 25, forum.topics_count);

  var topics = yield db.findTopicsByForumId(this.params.forumId, pager.limit, pager.offset);
  forum.topics = topics;
  forum = pre.presentForum(forum);
  yield this.render('show_forum', {
    ctx: this,
    forum: forum,
    currPage: pager.currPage,
    totalPages: pager.totalPages
  });
});

//
// Create post
// Body params:
// - post-type
// - text
//
app.post('/topics/:topicId/posts', function*() {
  this.checkBody('post-type').isIn(['ic', 'ooc', 'char'], 'Invalid post-type');
  this.checkBody('text').isLength(config.MIN_POST_LENGTH,
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
  var topic = yield db.findTopic(this.params.topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'CREATE_POST', topic);

  // If non-rp forum, then the post must be 'ooc' type
  if (!topic.forum.is_roleplay)
    this.assert(postType === 'ooc', 400);

  var text = this.request.body.text;
  // TODO: Validation
  var post = yield db.createPost({
    userId: this.currUser.id,
    ipAddress: this.request.ip,
    topicId: topic.id,
    text: text,
    type: postType,
    isRoleplay: topic.forum.is_roleplay
  });
  this.log.info({ post: post }, 'Post created');
  post = pre.presentPost(post);
  this.response.redirect(post.url);
});

//
// Show convos
//
app.use(route.get('/me/convos', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 404);
  var convos = yield db.findConvosInvolvingUserId(this.currUser.id);
  convos = convos.map(pre.presentConvo);
  yield this.render('me_convos.html', {
    ctx: this,
    convos: convos
  });
}));

//
// Show user
//
app.get('/users/:userId', function*() {
  this.checkQuery('before-id').optional().toInt();  // will be undefined or number
  var userId = this.params.userId;
  var user = yield db.findUser(userId);
  // Ensure user exists
  this.assert(user, 404);
  user = pre.presentUser(user);
  // OPTIMIZE: Merge into single query?
  var recentPosts = yield db.findRecentPostsForUserId(user.id,
                                                      this.query['before-id']);
  recentPosts = recentPosts.map(pre.presentPost);

  // The ?before-id=_ of the "Next" button. i.e. the lowest
  // id of the posts on the current page
  var nextBeforeId = recentPosts.length > 0 ? _.last(recentPosts).id : null;

  yield this.render('show_user', {
    ctx: this,
    user: user,
    recentPosts: recentPosts,
    // Pagination
    nextBeforeId: nextBeforeId,
    recentPostsPerPage: config.RECENT_POSTS_PER_PAGE
  });
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
// - 'text'
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
  this.checkBody('text').isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH,
                                  'Text required');

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
  var text = this.request.body.text;
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

  // If all unames are valid, then we can create a convo
  var convo = yield db.createConvo({
    userId: this.currUser.id,
    toUserIds: _.pluck(users, 'id'),
    title: title,
    text: text,
    ipAddress: this.request.ip
  });
  this.log.info({ convo: convo, text: belt.truncate(text, 100) }, 'Created convo');
  convo = pre.presentConvo(convo);
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
    to: this.request.query.to
  });
}));

//
// Create PM
// Body params
// - text
//
app.use(route.post('/convos/:convoId/pms', function*(convoId) {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 403);
  this.checkBody('text').isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('/convos/' + convoId);
    return;
  }

  var convo = yield db.findConvo(convoId);
  this.assert(convo, 404);
  this.assertAuthorized(this.currUser, 'CREATE_PM', convo);

  var text = this.request.body.text;
  var pm = yield db.createPm({
    userId: this.currUser.id,
    ipAddress: this.request.ip,
    convoId: convoId,
    text: text});
  this.log.info({ pm: pm }, 'Created PM');
  pm = pre.presentPm(pm);
  this.response.redirect(pm.url);
}));

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

  var pms = yield db.findPmsByConvoId(convoId, page);
  convo.pms = pms;
  convo = pre.presentConvo(convo);
  yield this.render('show_convo', {
    ctx: this,
    convo: convo,
    // Pagination
    currPage: page,
    totalPages: totalPages
  });
}));

//
// Create topic
//
// Body params:
// - forum-id
// - title
// - text
//
app.post('/forums/:forumId/topics', function*() {
  this.checkBody('title')
    .notEmpty('Topic title is required')
    .isLength(config.MIN_TOPIC_TITLE_LENGTH,
              config.MAX_TOPIC_TITLE_LENGTH,
              'Title must be between ' +
              config.MIN_TOPIC_TITLE_LENGTH + ' and ' +
              config.MAX_TOPIC_TITLE_LENGTH + ' chars');
  this.checkBody('text')
    .notEmpty('Post text is required')
    .isLength(config.MIN_POST_LENGTH,
              config.MAX_POST_LENGTH,
              'Post text must be between ' +
              config.MIN_POST_LENGTH + ' and ' +
              config.MAX_POST_LENGTH + ' chars');

  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('/forums/' + this.params.forumId);
    return;
  }

  var forumId = this.params.forumId;
  var title = this.request.body.title;
  var text = this.request.body.text;

  var forum = yield db.findForum(this.params.forumId);
  this.assert(forum, 404);
  this.assertAuthorized(this.currUser, 'CREATE_TOPIC', forum);

  var postType = forum.is_roleplay ? 'ic' : 'ooc';
  var topic = yield db.createTopic({
    userId: this.currUser.id,
    forumId: forumId,
    ipAddress: this.request.ip,
    title: title,
    text: text,
    postType: postType,
    isRoleplay: forum.is_roleplay
  });
  this.log.info({
    topic: topic,
    text: belt.truncate(text, 100),
    post_type: postType
  }, 'Created topic');
  topic = pre.presentTopic(topic);
  this.response.redirect(topic.url);
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
  this.body = post.text;
});

app.get('/pms/:id/raw', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 404);
  var pm = yield db.findPmWithConvo(this.params.id);
  this.assert(pm, 404);
  this.assertAuthorized(this.currUser, 'READ_PM', pm);
  this.body = pm.text;
});

//
// Update post text
// Body params:
// - text
//
// Keep /api/posts/:postId and /api/pms/:pmId in sync
app.put('/api/posts/:id', function*() {
  this.checkBody('text').isLength(config.MIN_POST_LENGTH,
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

  var text = this.request.body.text;
  var updatedPost = yield db.updatePost(this.params.id, text);
  updatedPost = pre.presentPost(updatedPost);
  this.body = JSON.stringify(updatedPost);
});

app.put('/api/pms/:id', function*() {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.checkBody('text').isLength(config.MIN_POST_LENGTH,
                                  config.MAX_POST_LENGTH);
  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('back');
    return;
  }

  this.assert(this.currUser, 404);
  var pm = yield db.findPmWithConvo(this.params.id);
  this.assert(pm, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_PM', pm)

  var text = this.request.body.text;
  var updatedPm = yield db.updatePm(this.params.id, text);
  updatedPm = pre.presentPm(updatedPm);

  this.body = JSON.stringify(updatedPm);
});

//
// Update topic status
// Params
// - status (Required) String, one of STATUS_WHITELIST
//
app.use(route.put('/topics/:topicId/status', function*(topicId) {
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
}));

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
//
// Calculates pagination offset and redirects to
// canonical topic page since the page a post falls on depends on
// currUser. For example, members can't see most hidden posts while
// mods can.
// - Keep this in sync with /pms/:pmId
//
app.use(route.get('/posts/:postId', function*(postId) {
  var post = yield db.findPostWithTopicAndForum(postId);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser, 'READ_POST', post);
  post = pre.presentPost(post);
  var redirectUrl;
  if (post.idx < config.POSTS_PER_PAGE)
    redirectUrl = post.topic.url + '/posts/' + post.type + '#post-' + post.id
  else
    redirectUrl = post.topic.url + '/posts/' + post.type +
                  '?page=' +
                  Math.ceil((post.idx + 1) / config.POSTS_PER_PAGE) +
                  '#post-' + post.id;
  this.response.redirect(redirectUrl);
}));

// PM permalink
// Keep this in sync with /posts/:postId
app.use(route.get('/pms/:id', function*(id) {
  if (!config.IS_PM_SYSTEM_ONLINE)
    return this.body = 'PM system currently disabled';

  this.assert(this.currUser, 404);
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
}));

//
// Canonical show topic
//
app.use(route.get('/topics/:topicId/posts/:postType', function*(topicId, postType) {
  debug('[GET /topics/:topicId/posts/:postType]');
  this.assert(_.contains(['ic', 'ooc', 'char'], postType), 404);
  this.checkQuery('page').optional().toInt();
  this.assert(!this.errors, 400, belt.joinErrors(this.errors))

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

  // If user tried to go to ic/char tabs on a non-rp, then 404
  if (!topic.is_roleplay)
    this.assert(!_.contains(['ic', 'char'], postType), 404);

  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  var totalItems = topic[postType + '_posts_count'];
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Don't need this page when post pages are pre-calc'd in the database
  // var pager = belt.calcPager(page, config.POSTS_PER_PAGE, totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl = page === 1 ? this.request.path :
                                   this.request.path + '?page=' + totalPages;
    return this.response.redirect(redirectUrl);
  }

  var posts = yield db.findPostsByTopicId(topicId, postType, page);
  topic.posts = posts;
  topic = pre.presentTopic(topic);
  yield this.render('show_topic', {
    ctx: this,
    topic: topic,
    postType: postType,
    // Pagination
    currPage: page,
    totalPages: totalPages
  });
}));

//
// Redirect topic to canonical url
//
app.use(route.get('/topics/:topicId', function*(topicId) {
  debug('[GET /topics/:topicId]');
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  if (topic.forum.is_roleplay)
    this.response.redirect(this.request.path + '/posts/ic');
  else
    this.response.redirect(this.request.path + '/posts/ooc');
}));

app.listen(config.PORT);
console.log('Listening on ' + config.PORT);
