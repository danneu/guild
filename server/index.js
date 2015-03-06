var config = require('./config');

// Koa deps
var app = require('koa')();
app.poweredBy = false;
app.proxy = true;
app.use(require('koa-static')('public'));
app.use(require('koa-static')('dist', { maxage: 1000 * 60 * 60 * 24 * 365 }));
app.use(require('koa-logger')());
app.use(require('koa-body')({
  multipart: true,
  // Max payload size allowed in request form body
  // Defaults to '56kb'
  formLimit: '25mb'
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
var uuid = require('node-uuid');
var coParallel = require('co-parallel');
// 1st party
var db = require('./db');
var pre = require('./presenters');
var middleware = require('./middleware');
var cancan = require('./cancan');
var emailer = require('./emailer');
var cache = require('./cache')();
var belt = require('./belt');
var bbcode = require('./bbcode');
var welcomePm = require('./welcome_pm');
var avatar = require('./avatar');
var bouncer = require('koa-bouncer');

// Catch and log all errors that bubble up to koa
// app.on('error', function(err) {
//   log.error(err, 'Error');
//   console.error('Error:', err, err.stack);
// });

// app.use(function*(next) {
//   var start = Date.now();
//   this.log = log.child({ req_id: uuid.v1() });  // time-based uuid
//   this.log.info({ req: this.request }, '--> %s %s', this.method, this.path);
//   yield next;
//   var diff = Date.now() - start;
//   this.log.info({ ms: diff, res: this.response },
//                 '<-- %s %s %s %s',
//                 this.method, this.path, this.status, diff + 'ms');
// });

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
  //log.info({ dist: dist }, 'dist set');
}, function(err) {
  console.error('dist failed', dist);
  //log.error(err, 'dist failed');
});

// Only allow guild to be iframed from same domain
app.use(function*(next) {
  this.set('X-Frame-Options', 'SAMEORIGIN');
  yield next;
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

// Remove trailing slashes from url path
app.use(function*(next) {
  // If path has more than one character and ends in a slash, then redirect to
  // the same path without that slash. Note: homepage is "/" which is why
  // we check for more than 1 char.
  if (/.+\/$/.test(this.request.path)) {
    var newPath = this.request.path.slice(0, this.request.path.length-1);
    this.status = 301;
    this.response.redirect(newPath + this.request.search);
  }

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
    // ctx.log.info('[assertAuthorized] Can %s %s: %s',
    //              (user && user.uname) || '<Guest>', action, canResult);
    console.log(util.format('[assertAuthorized] Can %s %s: %s',
                            (user && user.uname) || '<Guest>', action, canResult));
    ctx.assert(canResult, 403);
  };
  yield next;
});

// Custom Swig filters
////////////////////////////////////////////////////////////

swig.setDefaults({
  locals: {
    '_': _,
    'belt': belt,
    'cancan': cancan
  }
});

swig.setFilter('expandJoinStatus', belt.expandJoinStatus);

// {% if user.id|isIn([1, 2, 3]) %}
swig.setFilter('isIn', function(v, coll) {
  return _.contains(coll, v);
});

// {% if things|isEmpty %}
swig.setFilter('isEmpty', function(coll) {
  return _.isEmpty(coll);
});

// Specifically replaces \n with <br> in user.custom_title
swig.setFilter('replaceTitleNewlines', function(str) {
  if (!str) return '';
  return _.escape(str).replace(/\\n/, '<br>').replace(/^<br>|<br>$/g, '');
});
swig.setFilter('replaceTitleNewlinesMobile', function(str) {
  if (!str) return '';
  return _.escape(str).replace(/(?:\\n){2,}/, '\n').replace(/^\\n|\\n$/g, '').replace(/\\n/, ' / ');
});

// Sums `nums`, an array of numbers. Returns zero if `nums` is falsey.
swig.setFilter('sum', function(nums) {
  return (nums || []).reduce(function(memo, n) {
    return memo + n;
  }, 0);
});

// Sums the values of an object
swig.setFilter('sumValues', function(obj) {
  return (_.values(obj)).reduce(function(memo, n) {
    return memo + n;
  }, 0);
});

swig.setFilter('ratingTypeToImageSrc', function(type) {
  switch(type) {
    case 'like':
      return '/ratings/like.png';
    case 'laugh':
      return '/ratings/laugh-static.png';
    case 'thank':
      return '/ratings/thank.png';
    default:
      throw new Error('Unsupported rating type: ' + type);
  }
});

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
swig.setFilter('slugifyUname', belt.slugifyUname);

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

app.use(bouncer.middleware());

app.use(function*(next) {
  try {
    yield next;
  } catch(ex) {
    if (ex instanceof bouncer.ValidationError) {
      this.flash = {
        message: ['danger', ex.message || 'Validation error'],
        // FIXME: This breaks if body is bigger than ~4kb cookie size limit
        // i.e. large posts, large bodies of text
        params: this.request.body
      };
      this.response.redirect('back');
      return;
    }
    throw ex;
  }
});

// TODO: Migrate from route to koa-router.
// For one, it lets koa-validate's checkParams work since it puts the params
// in the koa context
// - Create middleware before this
app.use(require('koa-router')(app));

app.post('/test', function*() {
  this.body = JSON.stringify(this.request.body, null, '  ');
});

// Useful to redirect users to their own profiles since canonical edit-user
// url is /users/:slug/edit

// Ex: /me/edit#grayscale-avatars to show users how to toggle that feature
app.get('/me/edit', function*() {
  // Ensure current user can edit themself
  this.assertAuthorized(this.currUser, 'UPDATE_USER', this.currUser);

  // Note: Redirects fragment params
  this.response.redirect('/users/' + this.currUser.slug + '/edit');
});

app.post('/topics/:topicSlug/co-gms', function*() {
  var topicId = belt.extractId(this.params.topicSlug);
  var topic = yield db.findTopicById(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_TOPIC_CO_GMS', topic);
  topic = pre.presentTopic(topic);

  this.validateBody('uname')
    .notEmpty('Username required');
  var user = yield db.findUserByUname(this.vals.uname);
  // Ensure user exists
  this.validate(user, 'User does not exist');
  // Ensure user is not already a co-GM
  this.validate(!_.contains(topic.co_gm_ids, user.id), 'User is already a co-GM');
  // Ensure user is not the GM
  this.validate(user.id !== topic.user.id, 'User is already the GM');
  // Ensure topic has room for another co-GM
  this.validate(topic.co_gm_ids.length < config.MAX_CO_GM_COUNT,
                'Cannot have more than ' + config.MAX_CO_GM_COUNT + ' co-GMs');

  yield db.updateTopicCoGms(topic.id, topic.co_gm_ids.concat([user.id]));

  this.flash = {
    message: ['success', util.format('Co-GM added: %s', this.vals.uname)]
  };
  this.response.redirect(topic.url + '/edit#co-gms');
});

app.delete('/topics/:topicSlug/co-gms/:userSlug', function*() {
  var topicId = belt.extractId(this.params.topicSlug);
  var topic = yield db.findTopicById(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_TOPIC_CO_GMS', topic);
  topic = pre.presentTopic(topic);

  var user = yield db.findUserBySlug(this.params.userSlug);
  this.validate(user, 'User does not exist');
  this.validate(_.contains(topic.co_gm_ids, user.id), 'User is not a co-GM');

  yield db.updateTopicCoGms(topic.id, topic.co_gm_ids.filter(function(co_gm_id) {
    return co_gm_id !== user.id;
  }));

  this.flash = {
    message: ['success', util.format('Co-GM removed: %s', user.uname)]
  };
  this.response.redirect(topic.url + '/edit#co-gms');
});

app.get('/unames.json', function*() {
  this.type = 'application/json';
  this.body = yield db.findAllUnamesJson();
});

// Required body params:
// - type: like | laugh | thank
// - post_id: Int
app.post('/posts/:postId/rate', function*() {
  try {
    this.validateBody('type')
      .notEmpty('type is required')
      .isIn(['like', 'laugh', 'thank'], 'Invalid type');
    this.validateBody('post_id').toInt('Invalid post_id');
  } catch(ex) {
    if (ex instanceof bouncer.ValidationError)
      this.throw(ex.message, 400);
    throw ex;
  }

  var post = yield db.findPostById(this.vals.post_id);

  // Ensure post exists (404)
  this.assert(post, 404);
  post = pre.presentPost(post);

  // Ensure currUser is authorized to rep (403)
  this.assert(cancan.can(this.currUser, 'RATE_POST', post), 403);

  // Ensure user has waited a certain duration since giving latest rating.
  // (To prevent rating spamming)
  var prevRating = yield db.findLatestRatingForUserId(this.currUser.id);
  if (prevRating) {
    var thirtySecondsAgo = new Date(Date.now() - 1000 * 30);
    // If this user's previous rating is newer than 30 seconds ago, fail.
    if (prevRating.created_at > thirtySecondsAgo) {
      this.body = JSON.stringify({ error: 'TOO_SOON' });
      this.status = 400;
      return;
    }
  }

  // Create rep
  var rating = yield db.ratePost({
    post_id: post.id,
    from_user_id: this.currUser.id,
    from_user_uname: this.currUser.uname,
    to_user_id: post.user_id,
    type: this.vals.type
  });

  // Send receiver a RATING notification in the background
  co(db.createRatingNotification({
    from_user_id: this.currUser.id,
    to_user_id:   post.user_id,
    post_id:      post.id,
    topic_id:     post.topic_id,
    rating_type:  rating.type
  }));

  this.body = JSON.stringify(rating);
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

  // Validation

  this.validateBody('uname')
    .notEmpty('Username required')
    .trim()
    .isLength(config.MIN_UNAME_LENGTH,
              config.MAX_UNAME_LENGTH,
              'Username must be ' + config.MIN_UNAME_LENGTH +
              '-' + config.MAX_UNAME_LENGTH + ' characters')
    .match(/^[a-z0-9 ]+$/i, 'Username must only contain a-z, 0-9, and spaces')
    .match(/[a-z]/i, 'Username must contain at least one letter (a-z)')
    .notMatch(/^[-]/, 'Username must not start with hyphens')
    .notMatch(/[-]$/, 'Username must not end with hyphens')
    .notMatch(/[ ]{2,}/, 'Username contains consecutive spaces')
    .checkNot(yield db.findUserByUname(this.vals.uname), 'Username taken');
  this.validateBody('email')
    .notEmpty('Email required')
    .trim()
    .isEmail('Email must be valid')
    .checkNot(yield db.findUserByEmail(this.vals.email), 'Email taken');
  this.validateBody('password2')
    .notEmpty('Password confirmation required');
  this.validateBody('password1')
    .notEmpty('Password required')
    .eq(this.vals.password2, 'Password confirmation must match');
  this.validateBody('g-recaptcha-response')
    .notEmpty('You must attempt the human test');

  // Validation success

  // Check recaptcha against google
  var passedRecaptcha = yield belt.makeRecaptchaRequest({
    userResponse: this.vals['g-recaptcha-response'],
    userIp: this.request.ip
  });
  if (! passedRecaptcha) {
    debug('Google rejected recaptcha');
    this.flash = {
      message: ['danger', 'You failed the recaptcha challenge'],
      params: this.request.body
    };
    return this.response.redirect('/register');
  }

  // User params validated, so create a user and log them in
  var result, errMessage;
  try {
    result = yield db.createUserWithSession({
      uname: this.vals.uname,
      email: this.vals.email,
      password: this.vals.password1,
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
    expires: belt.futureDate({ years: 1 })
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
  this.validateBody('uname-or-email').notEmpty('Invalid creds');
  this.validateBody('password').notEmpty('Invalid creds');
  this.validateBody('remember-me').toBoolean();
  var user = yield db.findUserByUnameOrEmail(this.vals['uname-or-email']);
  this.validate(user, 'Invalid creds');
  this.validate(yield belt.checkPassword(this.vals['password'], user.digest), 'Invalid creds');

  // User authenticated
  var session = yield db.createSession({
    userId:    user.id,
    ipAddress: this.request.ip,
    interval:  (this.vals['remember-me'] ? '1 year' : '2 weeks')
  });

  this.cookies.set('sessionId', session.id, {
    expires: this.vals['remember-me'] ? belt.futureDate({ years: 1 }) : undefined
  });
  this.flash = { message: ['success', 'Logged in successfully'] };
  this.response.redirect('/');
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
  var categories = cache.get('categories');

  // We don't show the mod forum on the homepage.
  // Nasty, but just delete it for now
  // TODO: Abstract
  _.remove(categories, { id: 4 });

  var categoryIds = _.pluck(categories, 'id');
  var allForums = _.flatten(_.pluck(categories, 'forums'));

  // Assoc forum viewCount from cache
  var viewerCounts = cache.get('forum-viewer-counts');
  allForums.forEach(function(forum) {
    forum.viewerCount = viewerCounts[forum.id];
  });

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
    stats: stats,
    // For sidebar
    latestChecks: cache.get('latest-checks').map(pre.presentTopic),
    latestRoleplays: cache.get('latest-roleplays').map(pre.presentTopic)
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

  this.flash = { message: ['success', 'Successfully unsubscribed'] };
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
    //this.log.info('User not found with email: %s', email);
    this.flash = { message: ['success', successMessage]};
    this.response.redirect('/');
    return;
  }

  // Don't send another email until previous reset token has expired
  if (yield db.findLatestActiveResetToken(user.id)) {
    //this.log.info('User already has an active reset token');
    this.flash = { message: ['success', successMessage] };
    this.response.redirect('/');
    return;
  }

  var resetToken = yield db.createResetToken(user.id);
  //this.log.info({ resetToken: resetToken }, 'Created reset token');
  // Send email in background
  //this.log.info('Sending email to %s', user.email);
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
    title: 'Edit ' + user.uname
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
// - custom-title
// - is-grayscale
app.put('/users/:slug', function*() {
  debug('BEFORE', this.request.body);

  this.checkBody('email')
    .optional()
    .isEmail('Invalid email address');
  this.checkBody('sig')
    .optional()
  this.checkBody('avatar-url')
    .optional()
  this.checkBody('custom-title')
    .optional()
  if (this.request.body['custom-title'])
    this.checkBody('custom-title')
      .trim()
      .isLength(0, 50, 'custom-title can be up to 50 chars. Yours was ' + this.request.body['custom-title'].length + '.')
  if (this.request.body['avatar-url'] && this.request.body['avatar-url'].length > 0)
    this.checkBody('avatar-url')
      .trim()
      .isUrl('Must specify a URL for the avatar');
  // Coerce checkboxes to bool only if they are defined
  if (!_.isUndefined(this.request.body['hide-sigs']))
    this.checkBody('hide-sigs').toBoolean();
  if (!_.isUndefined(this.request.body['is-ghost']))
    this.checkBody('is-ghost').toBoolean();
  if (!_.isUndefined(this.request.body['is-grayscale']))
    this.checkBody('is-grayscale').toBoolean();

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
    custom_title: this.request.body['custom-title'],
    avatar_url: this.request.body['avatar-url'],
    hide_sigs: _.isBoolean(this.request.body['hide-sigs'])
                 ? this.request.body['hide-sigs']
                 : user.hide_sigs,
    is_ghost: _.isBoolean(this.request.body['is-ghost'])
                ? this.request.body['is-ghost']
                : user.is_ghost,
    is_grayscale: _.isBoolean(this.request.body['is-grayscale'])
                 ? this.request.body['is-grayscale']
                 : user.is_grayscale
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
// Refresh forum
//
// Recalculates forum caches including the counter caches and
// the latest_post_id and latest_post_at
app.post('/forums/:forumSlug/refresh', function*() {
  // Load forum
  var forumId = belt.extractId(this.params.forumSlug);
  this.assert(forumId, 404);
  var forum = yield db.findForum(forumId);
  this.assert(forum, 404);
  forum = pre.presentForum(forum);

  // Authorize user
  this.assertAuthorized(this.currUser, 'REFRESH_FORUM', forum);

  // Refresh forum
  yield db.refreshForum(forum.id);

  // Redirect to homepage
  this.flash = {
    message: ['success', 'Forum refreshed. It may take up to 10 seconds for the changes to be reflected on the homepage.']
  };
  this.response.redirect('/');
});

//
// New topic form
//
app.get('/forums/:forumSlug/topics/new', function*() {
  // Load forum
  var forumId = belt.extractId(this.params.forumSlug);
  this.assert(forumId, 404);
  var forum = yield db.findForum(forumId);
  this.assert(forum, 404);
  forum = pre.presentForum(forum);

  // Ensure user authorized to create topic in this forum
  this.assertAuthorized(this.currUser, 'CREATE_TOPIC', forum);

  // Get tag groups
  var tagGroups = forum.has_tags_enabled ? yield db.findAllTagGroups() : [];

  var toArray = function(stringOrArray) {
    return _.isArray(stringOrArray) ? stringOrArray : [stringOrArray];
  };

  // Render template
  yield this.render('new_topic', {
    ctx: this,
    forum: forum,
    tagGroups: tagGroups,
    postType: (this.flash.params && this.flash.params['post-type']) || 'ooc',
    initTitle: this.flash.params && this.flash.params.title,
    selectedTagIds: (
      this.flash.params
        && toArray(this.flash.params['tag-ids']).map(function(idStr) {
          return parseInt(idStr);
        }))
      || []
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
    this.status = 301;
    this.response.redirect(forum.url + this.request.search);
    return;
  }

  this.assertAuthorized(this.currUser, 'READ_FORUM', forum);

  var pager = belt.calcPager(this.request.query.page, 25, forum.topics_count);

  co(db.upsertViewer(this, forum.id));

  // Avoid the has_posted subquery if guest
  var thunk, results, topics, viewers;
  if (this.currUser)
    thunk = db.findTopicsWithHasPostedByForumId(
      forumId, pager.limit, pager.offset, this.currUser.id
    );
  else
    thunk = db.findTopicsByForumId(forumId, pager.limit, pager.offset);

  results = yield [db.findViewersForForumId(forum.id), thunk];
  viewers = results[0];
  topics = results[1];

  forum.topics = topics;
  forum = pre.presentForum(forum);
  yield this.render('show_forum', {
    ctx: this,
    forum: forum,
    currPage: pager.currPage,
    totalPages: pager.totalPages,
    title: forum.title,
    className: 'show-forum',
    // Viewers
    viewers: viewers
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
              config.MAX_POST_LENGTH + ' chars long. Yours was ' +
              this.request.body.markup.length);

  if (this.errors) {
    // Can't store post in flash params because cookie limit is like 4kb
    this.body = belt.joinErrors(this.errors) +
      ' -- Press the back button and try again.';
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

  // Send MENTION and QUOTE notifications
  var results = yield [
    db.parseAndCreateMentionNotifications({
      fromUser: this.currUser,
      markup: this.request.body.markup,
      post_id: post.id,
      topic_id: post.topic_id
    }),
    db.parseAndCreateQuoteNotifications({
      fromUser: this.currUser,
      markup: this.request.body.markup,
      post_id: post.id,
      topic_id: post.topic_id
    })
  ];

  var mentionNotificationsCount = results[0].length;
  var quoteNotificationsCount = results[1].length;

  this.flash = {
    message: [
      'success',
      util.format('Post created. Mentions sent: %s, Quotes sent: %s',
                  mentionNotificationsCount, quoteNotificationsCount)]
  };

  this.response.redirect(post.url);
});

//
// Search users
//
app.get('/users', function*() {
  this.assertAuthorized(this.currUser, 'READ_USER_LIST');

  // undefined || String
  this.checkQuery('text')
    .optional()
    .isLength(3, 15, 'Username must be 3-15 chars')
  this.checkQuery('before-id').optional().toInt();  // undefined || Number

  if (this.errors) {
    this.flash = {
      message: ['danger', belt.joinErrors(this.errors)],
      params: this.request.body
    };
    this.response.redirect('/users');
    return;
  }

  var usersList;
  if (this.query['before-id']) {
    if (this.query['text']) {
      //this.checkQuery('text').notEmpty().isLength(1, 15, 'Search text must be 1-15 chars');
      usersList = yield db.findUsersContainingStringWithId(this.query['text'], this.query['before-id']);
    }else {
      usersList = yield db.findAllUsers(this.query['before-id']);
    }
  }else if (this.query['text']) {
    //this.checkQuery('text').notEmpty().isLength(1, 15, 'Search text must be 1-15 chars');
    usersList = yield db.findUsersContainingString(this.query['text']);
  }else {
    usersList = yield db.findAllUsers();
  }

  usersList = usersList.map(pre.presentUser);

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
    this.status = 301;
    this.response.redirect('/users/' + user.slug);
    return;
  }

  this.checkQuery('before-id').optional().toInt();  // will be undefined or number
  var userId = this.params.userIdOrSlug;

  // FIXME: Keep in sync with cancan READ_USER_RATINGS_TABLE
  // If currUser is a guest or if currUser is
  if (this.currUser &&
      (cancan.isStaffRole(this.currUser.role) || this.currUser.slug === userId))
    user = yield db.findUserWithRatingsBySlug(userId);
  else
    user = yield db.findUserBySlug(userId);
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
    title: user.uname,
    // Pagination
    nextBeforeId: nextBeforeId,
    recentPostsPerPage: config.RECENT_POSTS_PER_PAGE
  });
});

////////////////////////////////////////////////////////////

var LEGACY_VBULLETIN_PATHS = [
  '/forumdisplay.php',
  '/misc.php',
  '/external.php',
  '/showgroups.php',
  '/register.php',
  '/index.php',
  '/activity.php',
  '/forum.php',
  '/showthread.php',
  '/printthread.php',
  '/private.php'
];

LEGACY_VBULLETIN_PATHS.forEach(function(legacyPath) {
  app.get(legacyPath, function*() {
    this.flash = { message: ['info', 'Sorry, that page does not exist anymore.'] };
    this.status = 301;
    this.response.redirect('/');
  });
});

////////////////////////////////////////////////////////////

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
  if (this.request.query.page === 1) {
    this.status = 301;
    return this.response.redirect(this.request.path);
  }

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
    title: convo.title,
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
// Update topic tags
// - tag-ids: Required [StringIds]
//
app.put('/topics/:topicSlug/tags', function*() {
  // Load topic
  var topicId = belt.extractId(this.params.topicSlug);
  this.assert(topicId, 404);
  var topic = yield db.findTopicById(topicId);
  this.assert(topic, 404);
  topic = pre.presentTopic(topic);

  // Authorize user
  this.assertAuthorized(this.currUser, 'UPDATE_TOPIC_TAGS', topic);

  // Validate body params
  this.validateBody('tag-ids')
    .toInts()
    .uniq()
    .isLength(1, 5, 'Must select 1-5 tags');
  this.vals['tag-ids'] = this.vals['tag-ids'].filter(function(n) {
    return n > 0;
  });

  // Add this forum's tag_id if it has one
  var tagIds = _.chain(this.vals['tag-ids'])
    .concat(topic.forum.tag_id ? [topic.forum.tag_id] : [])
    .uniq()
    .value();

  // Update topic
  yield db.updateTopicTags(topic.id, tagIds);

  this.flash = { message: ['success', 'Tags updated'] };
  this.response.redirect(topic.url + '/edit');
});

//
// Create topic
//
// Body params:
// - forum-id
// - title
// - markup
// - tag-ids: Array of StringIntegers (IntChecks/RPs only for now)
// - join-status
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
  this.validateBody('title')
    .notEmpty('Title is required')
    .isLength(config.MIN_TOPIC_TITLE_LENGTH,
              config.MAX_TOPIC_TITLE_LENGTH,
              'Title must be between ' +
              config.MIN_TOPIC_TITLE_LENGTH + ' and ' +
              config.MAX_TOPIC_TITLE_LENGTH + ' chars');
  this.validateBody('markup')
    .notEmpty('Post is required')
    .isLength(config.MIN_POST_LENGTH,
              config.MAX_POST_LENGTH,
              'Post must be between ' +
              config.MIN_POST_LENGTH + ' and ' +
              config.MAX_POST_LENGTH + ' chars');
  this.validateBody('forum-id')
    .notEmpty()
    .toInt();

  if (forum.is_roleplay) {
    this.validateBody('post-type')
      .notEmpty()
      .toLowerCase()
      .isIn(['ooc', 'ic'], 'post-type must be "ooc" or "ic"');
    this.validateBody('join-status')
      .notEmpty()
      .isIn(['jump-in', 'apply', 'full'], 'Invalid join-status');
  }

  // Validate tags (only for RPs/Checks
  if (forum.has_tags_enabled) {
    this.validateBody('tag-ids')
      .toArray()
      .isLength(1, 5, 'Must select 1-5 tags')
      .toInts();
  }
  this.validateBody('tag-ids').default([]);
  this.vals['tag-ids'] = this.vals['tag-ids'].filter(function(n) {
    return n > 0;
  });


  debug({valid: this.vals, body: this.request.body});

  // Validation succeeded

  // Render BBCode to html
  var html = bbcode(this.vals.markup);

  // post-type is always ooc for non-RPs
  var postType = forum.is_roleplay ? this.vals['post-type'] : 'ooc';

  var tagIds = _.chain(this.vals['tag-ids'])
    .concat(forum.tag_id ? [forum.tag_id] : [])
    .uniq()
    .value();

  // Create topic
  var topic = yield db.createTopic({
    userId: this.currUser.id,
    forumId: forumId,
    ipAddress: this.request.ip,
    title: this.vals.title,
    markup: this.vals.markup,
    html: html,
    postType: postType,
    isRoleplay: forum.is_roleplay,
    tagIds: tagIds,
    joinStatus: this.vals['join-status']
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

  if (this.currUser) {
    // Delete notifications related to this post
    var notificationsDeletedCount = yield db.deleteNotificationsForPostId(
      this.currUser.id,
      this.params.postId
    );
    // Update the stale user
    this.currUser.notifications_count -= notificationsDeletedCount;
  }

  this.status = 301;
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

  this.status = 301;
  this.response.redirect(redirectUrl);
});

//
// Show topic edit form
// For now it's just used to edit topic title
// Ensure this comes before /topics/:slug/:xxx so that "edit" is not
// considered the second param
//
app.get('/topics/:slug/edit', function*() {
  this.assert(this.currUser, 403);
  var topicId = belt.extractId(this.params.slug);
  this.assert(topicId, 404);
  var topic = yield db.findTopicById(topicId);
  this.assert(topic, 404);
  topic = pre.presentTopic(topic);
  this.assertAuthorized(this.currUser, 'UPDATE_TOPIC', topic);

  // Get tag groups
  var tagGroups = yield db.findAllTagGroups();

  yield this.render('edit_topic', {
    ctx: this,
    topic: topic,
    selectedTagIds: _.pluck(topic.tags, 'id'),
    tagGroups: tagGroups,
    className: 'edit-topic'
  });
});

// Update topic
// Params:
// - title Required
app.put('/topics/:slug/edit', function*() {

  // Authorization
  this.assert(this.currUser, 403);
  var topicId = belt.extractId(this.params.slug);
  this.assert(topicId, 404);
  var topic = yield db.findTopicById(topicId);
  this.assert(topic, 404);
  topic = pre.presentTopic(topic);
  this.assertAuthorized(this.currUser, 'UPDATE_TOPIC_TITLE', topic);

  // Parameter validation

  try {

    if (this.request.body['title']) {
      this.assert(cancan.can(this.currUser, 'UPDATE_TOPIC_TITLE', topic));
      this.validateBody('title')
        .default(topic.title)
        .isLength(config.MIN_TOPIC_TITLE_LENGTH,
                  config.MAX_TOPIC_TITLE_LENGTH,
                  'Title must be ' +
                  config.MIN_TOPIC_TITLE_LENGTH + ' - ' +
                  config.MAX_TOPIC_TITLE_LENGTH + ' chars long');
    }

    if (this.request.body['join-status']) {
      this.assert(cancan.can(this.currUser, 'UPDATE_TOPIC_JOIN_STATUS', topic));
      this.validateBody('join-status')
        .default(topic.join_status)
        .isIn(['jump-in', 'apply', 'full'], 'Invalid join-status')
    }

  } catch(ex) {
    if (ex instanceof bouncer.ValidationError) {
      this.flash = {
        message: ['danger', ex.message],
        params: this.request.body
      };
      this.response.redirect(topic.url + '/edit');
      return;
    }
    throw ex;
  }

  // Validation succeeded, so update topic
  yield db.updateTopic(topic.id, {
    title: this.vals.title,
    join_status: this.vals['join-status']
  });

  this.flash = { message: ['success', 'Topic updated'] };
  this.response.redirect(topic.url + '/edit');
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
  if (this.request.query.page === 1) {
    this.status = 301;
    return this.response.redirect(this.request.path);
  }

  var page = Math.max(1, this.request.query.page || 1);

  // Only incur the topic_subscriptions join if currUser exists
  var topic;
  if (this.currUser) {
    topic = yield db.findTopicWithIsSubscribed(this.currUser.id, topicId);
  } else {
    topic = yield db.findTopicById(topicId);
  }
  this.assert(topic, 404);

  topic = pre.presentTopic(topic);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (this.params.slug !== expectedSlug) {
    this.status = 301;
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

  co(db.upsertViewer(this, topic.forum_id, topic.id));

  // Get viewers and posts in parallel
  var results = yield [
    db.findViewersForTopicId(topic.id),
    db.findPostsByTopicId(topicId, this.params.postType, page)
  ];
  var viewers = results[0];
  var posts = results[1];

  if (this.currUser) {
    posts.forEach(function(post) {
      var rating = _.findWhere(post.ratings, { from_user_id: this.currUser.id });
      post.has_rated = rating;
    }, this);
  }

  topic.posts = posts.map(pre.presentPost);
  var postType = this.params.postType;
  yield this.render('show_topic', {
    ctx: this,
    topic: topic,
    postType: postType,
    title: topic.is_roleplay ?
             '[' + postType.toUpperCase() + '] ' + topic.title +
               (page > 1 ? ' (Page '+ page +')' : '')
             : topic.title,
    categories: cache.get('categories'),
    className: 'show-topic',
    // Pagination
    currPage: page,
    totalPages: totalPages,
    // Viewer tracker
    viewers: viewers
  });
});

// Legacy URL
// Redirect to the new, shorter topic URL
app.get('/topics/:topicId/posts/:postType', function*() {
  var redirectUrl = '/topics/' + this.params.topicId + '/' + this.params.postType;
  this.status = 301;
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
    this.status = 301;
    this.response.redirect(topic.url + this.request.search);
    return;
  }

  // TODO: Should these be 301?
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

//
// GET /me/notifications
// List currUser's notifications
//
app.get('/me/notifications', function*() {
  this.assert(this.currUser, 404);
  var notifications = yield db.findReceivedNotificationsForUserId(this.currUser.id);
  notifications = notifications.map(pre.presentNotification);

  yield this.render('me_notifications', {
    ctx: this,
    notifications: notifications
  });
});

//
// Move topic
//
app.post('/topics/:slug/move', function*() {
  var topicId = belt.extractId(this.params.slug);
  var topic = yield db.findTopicById(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'MOVE_TOPIC', topic);
  topic = pre.presentTopic(topic);

  // Validation

  this.checkBody('forum-id')
    .notEmpty('forum-id required')
    .toInt('forum-id invalid')
    .neq(topic.forum_id, 'Topic already belongs to the forum you tried to move it to');
  this.checkBody('leave-redirect?')
    .toBoolean();

  if (this.errors) {
    this.flash = { message: ['danger', belt.joinErrors(this.errors)] };
    this.response.redirect(topic.url);
    return;
  }

  topic = yield db.moveTopic(
    topic.id,
    topic.forum_id,
    this.request.body['forum-id'],
    this.request.body['leave-redirect?']
  );
  topic = pre.presentTopic(topic);

  this.flash = {
    message: ['success', 'Topic moved']
  };

  this.response.redirect(topic.url);
});

//
// Delete currUser's rating for a post
//
app.delete('/me/ratings/:postId', function*() {
  // Ensure user is logged in
  this.assert(this.currUser, 403);
  var rating = yield db.findRatingByFromUserIdAndPostId(
    this.currUser.id, this.params.postId
  );
  // Ensure rating exists
  this.assert(rating, 404);

  // Ensure rating was created within 30 seconds
  var thirtySecondsAgo = new Date(Date.now() - 1000 * 30);
  // If this user's previous rating is newer than 30 seconds ago, fail.
  if (rating.created_at < thirtySecondsAgo) {
    this.status = 400;
    this.body = 'You cannot delete a rating that is older than 30 seconds';
    return;
  }

  yield db.deleteRatingByFromUserIdAndPostId(
    this.currUser.id, this.params.postId
  );

  this.response.redirect('/posts/' + this.params.postId);
});

// Params
// - submit: 'save' | 'delete'
// - files
//   - avatar
//     - path
app.post('/users/:slug/avatar', function*() {
  // Ensure user exists
  var user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);
  user = pre.presentUser(user);
  // Ensure currUser is authorized to update user
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);

  // Handle avatar delete button
  if (this.request.body.fields.submit === 'delete') {
    yield db.deleteAvatar(user.id);
    this.flash = { message: ['success', 'Avatar deleted'] };
    this.response.redirect(user.url + '/edit#avatar');
    return;
  }

  // Ensure params
  // FIXME: Sloppy/lame validation
  this.assert(this.request.body.files, 400, 'Must choose an avatar to upload');
  this.assert(this.request.body.files.avatar, 400, 'Must choose an avatar to upload');

  this.assert(this.request.body.files.avatar.size > 0, 400, 'Must choose an avatar to upload');
  // TODO: Do a real check. This just looks at mime type
  this.assert(this.request.body.files.avatar.type.startsWith('image'), 400, 'Must be an image');

  // Process avatar, upload to S3, and get the S3 url
  var avatarUrl = yield avatar.handleAvatar(
    user.id,
    this.request.body.files.avatar.path
  )

  // Save new avatar url to db
  yield db.updateUser(user.id, { avatar_url: avatarUrl });

  // Delete legacy avatar if it exists
  yield db.deleteLegacyAvatar(user.id);

  this.flash = { message: ['success', 'Avatar uploaded and saved'] };
  this.response.redirect(user.url + '/edit#avatar');
});

app.get('/ips/:ip_address', function*() {
  // Ensure authorization
  this.assertAuthorized(this.currUser, 'LOOKUP_IP_ADDRESS');

  var results = yield [
    db.findUsersWithPostsWithIpAddress(this.params.ip_address),
    db.findUsersWithPmsWithIpAddress(this.params.ip_address)
  ];
  var postsTable = results[0];
  var pmsTable = results[1];

  yield this.render('show_users_with_ip_address', {
    ctx: this,
    ip_address: this.params.ip_address,
    postsTable: postsTable,
    pmsTable: pmsTable
  });
});

//
// Show user ip addresses
//
app.get('/users/:slug/ips', function*() {
  // Load user
  var user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);

  // Authorize currUser
  this.assertAuthorized(this.currUser, 'READ_USER_IP', user);

  // Load ip addresses
  var ip_addresses = yield db.findAllIpAddressesForUserId(user.id);

  this.set('Content-Type', 'text/html');
  this.body = _.isEmpty(ip_addresses) ?
    'None on file'
    : ip_addresses.map(function(ip_address) {
      return '<a href="/ips/' + ip_address + '">' + ip_address + '</a>';
    }).join('<br>');
});

app.listen(config.PORT);
console.log('Listening on ' + config.PORT);
