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
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:index');
var assert = require('better-assert');
var swig = require('swig');
var fs = require('co-fs');
var co = require('co');
var path = require('path');
// 1st party
var db = require('./db');
var config = require('./config');
var pre = require('./presenters');
var belt = require('./belt');
var middleware = require('./middleware');
var valid = require('./validation');
var cancan = require('./cancan');
var emailer = require('./emailer');

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
  console.log('dist set');
}, function(err) {
  console.error('Error: ', err, err.stack);
});

app.use(function*(next) {
  this.dist = dist;
  yield next;
});

// TODO: Since app.proxy === true (we trust X-Proxy-* headers), we want to
// reject all requests that hit origin. app.proxy should only be turned on
// when app is behind trusted proxy like Cloudflare.

app.use(require('koa-validate')());
app.use(middleware.currUser());
app.use(middleware.flash('flash'));
app.use(function*(next) {  // Must become before koa-router
  var ctx = this;
  this.can = cancan.can;
  this.assertAuthorized = function(user, action, target) {
    debug('[assertAuthorized]');
    var canResult = cancan.can(user, action, target);
    debug('[',  action, ' canResult]: ', canResult);
    ctx.assert(canResult, 403);
  };
  yield next;
});

// Custom Swig filters
////////////////////////////////////////////////////////////

// TODO: Extract custom swig filters
// {{ 'firetruck'|truncate(5) }}  -> 'firet...'
// {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
function makeTruncate(suffix) {
  return function(str, n) {
    suffix = suffix || '';
    var sliced = str.slice(0, n).trim();
    var totalLength = sliced.length + suffix.length;
    if (totalLength >= str.length)
      return str;
    return sliced + suffix;
  };
}
swig.setFilter('truncate', makeTruncate('…'));

// commafy(10) -> 10
// commafy(1000000) -> 1,000,000
function commafy(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
swig.setFilter('commafy', commafy);

////////////////////////////////////////////////////////////

// Configure templating system to use `swig`
// and to find view files in `view` directory
app.use(views('../views', {
  default: 'html',  // Default extension is .html
  cache: (process.env.NODE_ENV === 'production' ? 'memory' : undefined), // consolidate bug hack
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
// - email (Optional)
// - g-recaptcha-response
app.use(route.post('/users', function*() {
  var unvalidatedParams = valid.fixNewUser(_.pick(this.request.body, [
    'uname',
    'email',
    'password1',
    'password2'
  ]));

  var validatedParams;

  // Validate the user-input
  try {
    validatedParams = yield valid.validateNewUser(unvalidatedParams);
  } catch(ex) {
    // Upon validation failure, redirect back to /register, but preserve
    // user input in flash so the form can be filled back in for user to
    // make changes
    if (_.isString(ex)) {
      this.flash = {
        message: ['danger', ex],
        params: unvalidatedParams
      };
      return this.response.redirect('/register');
    }

    throw ex;
  }

  // Expect the recaptcha form param
  if (! this.request.body['g-recaptcha-response']) {
    debug('Missing param: g-recaptcha-response');
    this.flash = {
      message: ['danger', 'You must attempt the human test'],
      params: unvalidatedParams
    };
    return this.response.redirect('/register');
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
  debug(validatedParams);
  var result = yield db.createUserWithSession({
    uname: validatedParams.uname,
    email: validatedParams.email,
    password: validatedParams.password1,
    ipAddress: this.request.ip
  });
  var user = result['user'];
  var session = result['session'];
  this.cookies.set('sessionId', session.id);
  this.flash = { message: ['success', 'Registered successfully'] };
  return this.response.redirect('/');
}));

//
// Create session
//
app.use(route.post('/sessions', function*() {
  // TODO: Validation
  var uname = this.request.body.uname;
  var password = this.request.body.password;
  var rememberMe = !!this.request.body['remember-me'];

  // Check if user with this uname exists
  var user = yield db.findUserByUname(uname);
  if (!user) {
    this.flash = { message: ['danger', 'Invalid creds'] };
    return this.response.redirect('/login');
  }

  // Check if provided password matches digest
  if (! (yield belt.checkPassword(password, user.digest))) {
    this.flash = { message: ['danger', 'Invalid creds'] };
    return this.response.redirect('/login');
  }

  // User authenticated
  var session = yield db.createSession({
    userId: user.id,
    ipAddress: this.request.ip,
    interval: (rememberMe ? '1 day' : '1 year')
  });

  this.cookies.set('sessionId', session.id);
  this.flash = { message: ['success', 'Logged in successfully'] };
  this.response.redirect('/');
}));

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
  _.remove(categories, { id: 6 });
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
  var stats = yield db.getStats();
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
    return this.response.redirect('/forgot');
  }
  // Check if it belongs to a user
  var user = yield db.findUserByEmail(email);

  // Don't let the user know if the email belongs to anyone.
  // Always look like a success
  if (!user) {
    this.flash = { message: ['success', 'Check your email']};
    return this.response.redirect('/');
  }

  var resetToken = yield db.createResetToken(user.id);
  // Send email in background
  emailer.sendResetTokenEmail(user.uname, user.email, resetToken.token);

  this.flash = { message: ['success', 'Check your email']};
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
app.use(route.post('/me/subscriptions', function*() {
  this.assert(this.currUser, 404);
  var topicId = this.request.body['topic-id'];
  this.assert(topicId, 404);
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'SUBSCRIBE_TOPIC', topic);
  // TODO: flash
  yield db.subscribeToTopic(this.currUser.id, topicId);

  topic = pre.presentTopic(topic);

  debug(this.request.body);
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
//
// TODO: This isn't very abstracted yet. Just an email endpoint for now.
//
app.put('/users/:userId', function*() {
  this.request.body.email;
  this.checkBody('email').optional().isEmail('Invalid email address');
  debug(this.errors);
  if (this.errors) {
    this.flash = { message: ['danger', belt.joinErrors(this.errors)] }
    return this.response.redirect(this.request.path + '/edit');
  }
  var user = yield db.findUser(this.params.userId);
  this.assert(user, 404);
  this.assertAuthorized(this.currUser, 'UPDATE_USER', user);
  yield db.updateUser(user.id, {
    email: this.request.body.email || user.email
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
//
app.use(route.post('/topics/:topicId/posts', function*(topicId) {
  var postType = this.request.body['post-type'];
  this.assert(_.contains(['ic', 'ooc', 'char'], postType), 404);
  var topic = yield db.findTopic(topicId);
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
  post = pre.presentPost(post);
  this.response.redirect(post.url);
}));

//
// Show convos
//
app.use(route.get('/me/convos', function*() {
  // TODO: Authz, pagination
  if (!this.currUser) return;
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
  var userId = this.params.userId;
  var user = yield db.findUser(userId);
  // Ensure user exists
  if (!user) return;
  user = pre.presentUser(user);
  // OPTIMIZE: Merge into single query?
  var recentPosts = yield db.findRecentPostsForUserId(user.id);
  recentPosts = recentPosts.map(pre.presentPost);

  yield this.render('show_user', {
    ctx: this,
    user: user,
    recentPosts: recentPosts
  });
});

//
// Create convo
// Params:
// - 'to': Comma-delimited string of unames user wants to send to
//
app.use(route.post('/convos', function*() {
  var ctx = this;
  this.assertAuthorized(this.currUser, 'CREATE_CONVO');
  // TODO: Validation, Error msgs, preserve params
  // TODO: Sponge this up into a fixer+validater
  var unames = this.request.body.to && this.request.body.to.split(',');
  var title = this.request.body.title;
  var text = this.request.body.text;
  // Remove empty
  unames = _.compact(unames.map(function(uname) {
    return uname.trim().toLowerCase();
  }));
  // Ensure no more than 5 unames specified
  if (unames.length > 5) return;
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
  convo = pre.presentConvo(convo);
  this.response.redirect(convo.url);
}));

//
// New Convo
//
// TODO: Implement typeahead
app.use(route.get('/convos/new', function*() {
  this.assertAuthorized(this.currUser, 'CREATE_CONVO');
  // TODO: Validation, Error msgs, preserve params
  yield this.render('new_convo', {
    ctx: this,
    to: this.request.query.to
  });
}));

//
// Create PM
//
app.use(route.post('/convos/:convoId/pms', function*(convoId) {
  var text = this.request.body.text;
  assert(text);
  // TODO: Validation
  var pm = yield db.createPm({
    userId: this.currUser.id,
    ipAddress: this.request.ip,
    convoId: convoId,
    text: text});
  pm = pre.presentPm(pm);
  this.response.redirect(pm.url);
}));

//
// View convo
//
app.use(route.get('/convos/:convoId', function*(convoId) {
  // TODO: Authz
  var convo = yield db.findConvo(convoId);
  if (!convo) return;
  this.assertAuthorized(this.currUser, 'READ_CONVO', convo);
  var pms = yield db.findPmsByConvoId(convoId);
  convo.pms = pms;
  convo = pre.presentConvo(convo);
  yield this.render('show_convo', {
    ctx: this,
    convo: convo
  });
}));

//
// Create topic
//
app.use(route.post('/forums/:forumId/topics', function*(forumId) {
  var forumId = this.request.body['forum-id'];
  var title = this.request.body.title;
  var text = this.request.body.text;

  var forum = yield db.findForum(forumId);
  if (!forum) return;

  this.assertAuthorized(this.currUser, 'CREATE_TOPIC', forum);

  // TODO: Validation
  var topic = yield db.createTopic({
    userId: this.currUser.id,
    forumId: forumId,
    ipAddress: this.request.ip,
    title: title,
    text: text,
    postType: forum.is_roleplay ? 'ic' : 'ooc',
    isRoleplay: forum.is_roleplay
  });
  topic = pre.presentTopic(topic);
  this.response.redirect(topic.url);
}));

//
// Post markdown view
//
// Returns the unformatted post source.
//
app.use(route.get('/posts/:postId/raw', function*(postId) {
  // TODO: Authz
  var post = yield db.findPostWithTopicAndForum(postId);
  this.assert(post, 404);
  this.assertAuthorized(this.currUser, 'READ_POST', post);
  this.body = post.text;
}));
// TODO: pm/:pmId/raw needs equivalent to findPostWithTopicAndForum
app.use(route.get('/pms/:pmId/raw', function*(pmId) {
  // TODO: Authz
  var pm = yield db.findPm(pmId);
  if (!pm) return;
  this.body = pm.text;
}));

//
// Update post text
//
// Keep /api/posts/:postId and /api/pms/:pmId in sync
app.use(route.put('/api/posts/:postId', function*(id) {
  var post = yield db.findPost(id);
  if (!post) return;
  this.assertAuthorized(this.currUser, 'UPDATE_POST', post)
  // TODO: Authz, validation
  var text = this.request.body.text;
  var updatedPost = yield db.updatePost(id, text);
  updatedPost = pre.presentPost(updatedPost);
  this.body = JSON.stringify(updatedPost);
}));
app.use(route.put('/api/pms/:id', function*(id) {
  // TODO: Authz, validation
  var text = this.request.body.text;
  var pm = yield db.updatePm(id, text);
  pm = pre.presentPm(pm);
  this.body = JSON.stringify(pm);
}));

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
  // TODO: Authz
  var post = yield db.findPostWithTopic(postId);
  if (!post) return;
  post = pre.presentPost(post);
  var redirectUrl;
  if (post.page === 1)
    redirectUrl = post.topic.url + '/posts/' + post.type + '#post-' + post.id
  else
    redirectUrl = post.topic.url + '/posts/' + post.type +
                  '?page=' + post.page +
                  '#post-' + post.id;
  this.response.redirect(redirectUrl);
}));
// PM permalink
// Keep this in sync with /posts/:postId
app.use(route.get('/pms/:id', function*(id) {
  // TODO: Authz
  var pm = yield db.findPmWithConvo(id);
  if (!pm) return;
  pm = pre.presentPm(pm);
  this.response.redirect(pm.convo.url + '#pm-' + pm.id);
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
  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  var totalItems = topic[postType + '_posts_count'];
  var totalPages = belt.calcTotalPostPages(totalItems);
  debug(totalPages);

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
