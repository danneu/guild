// Koa deps
var app = require('koa')();
app.poweredBy = false;
app.proxy = true;
app.use(require('koa-static')('public'));
app.use(require('koa-logger')());
app.use(require('koa-body')());
app.use(require('koa-methodoverride')('_method'));
var route = require('koa-route');
var views = require('koa-views');
// Node
var util = require('util');
var path = require('path');
// 3rd party
var _ = require('lodash');
var debug = require('debug')('app:index');
var assert = require('better-assert');
// 1st party
var db = require('./db');
var config = require('./config');
var pre = require('./presenters');
var belt = require('./belt');
var middleware = require('./middleware');
var valid = require('./validation');
var cancan = require('./cancan');

// Since app.proxy === true (we trust X-Proxy-* headers), we want to
// reject all requests that hit origin. app.proxy should only be turned on
// when app is behind trusted proxy like Cloudflare.
app.use(function*(next) {
  // Example:
  // if (this.request.headers.host === 'dev-guild.herokuapp.com') {
  //   this.body = 'Please do not connect directly to the origin server.';
  //   return;
  // }
  yield next;
});
app.use(middleware.currUser());
app.use(middleware.flash('flash'));

app.use(function*(next) {
  var ctx = this;
  this.can = cancan.can;
  this.assertAuthorized = function(user, action, target) {
    var canResult = cancan.can(user, action, target);
    debug('[' + action + ' canResult]: ' + canResult);
    ctx.assert(canResult, 403);
  };
  yield next;
});

// Configure templating system to use `swig`
// and to find view files in `view` directory
app.use(views('../views', {
  default: 'html',  // Default extension is .html
  cache: (process.env.NODE_ENV === 'production' ? 'memory' : undefined), // consolidate bug hack
  map: { html: 'swig' }
}));


////////////////////////////////////////////////////////////

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

  yield this.render('homepage', {
    ctx: this,
    categories: categories
  });
}));

//
// Show subscriptions
//
app.use(route.get('/me/subscriptions', function*() {
  this.assert(this.currUser, 404);
  var topics = yield db.findSubscribedTopicsForUserId(this.currUser.id);
  console.log(JSON.stringify(topics));
  var grouped = _.groupBy(topics, function(topic) {
    return topic.forum.is_roleplay;
  });
  var roleplayTopics = grouped[true];
  var nonroleplayTopics = grouped[false];
  yield this.render('subscriptions', {
    ctx: this,
    topics: topics,
    roleplayTopics: roleplayTopics,
    nonroleplayTopics: nonroleplayTopics
  });
}));

//
// Canonical show forum
//
app.use(route.get('/forums/:forumId', function*(forumId) {
  // TODO: Ensure currUser can view forum
  // TODO: Pagination
  var forum = yield db.findForum(forumId);
  if (!forum) return;
  var topics = yield db.findTopicsByForumId(forumId);
  forum.topics = topics;
  forum = pre.presentForum(forum);
  yield this.render('show_forum', {
    ctx: this,
    forum: forum
  });
}));

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
    type: postType
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
app.use(route.get('/users/:userId', function*(userId) {
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
}));

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
    postType: forum.is_roleplay ? 'ic' : 'ooc'
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
  var post = yield db.findPost(postId);
  if (!post) return;
  this.body = post.text;
}));
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
  var updatedPost = yield db.updatePost(this.currUser.id, id, text);
  updatedPost = pre.presentPost(updatedPost);
  this.body = JSON.stringify(updatedPost);
}));
app.use(route.put('/api/pms/:id', function*(id) {
  // TODO: Authz, validation
  var text = this.request.body.text;
  var pm = yield db.updatePm(this.currUser.id, id, text);
  pm = pre.presentPm(pm);
  this.body = JSON.stringify(pm);
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
  this.response.redirect(post.topic.url + '/posts/' + post.type + '#post-' + post.id);
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
  this.assert(_.contains(['ic', 'ooc', 'char'], postType), 404);
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  // TODO: Pagination
  var posts = yield db.findPostsByTopicId(topicId, postType);
  topic.posts = posts;
  topic = pre.presentTopic(topic);
  yield this.render('show_topic', {
    ctx: this,
    topic: topic,
    postType: postType
  });
}));

//
// Redirect topic to canonical url
//
app.use(route.get('/topics/:topicId', function*(topicId) {
  var topic = yield db.findTopic(topicId);
  this.assert(topic, 404);
  this.assertAuthorized(this.currUser, 'READ_TOPIC', topic);

  if (topic.forum.is_roleplay)
    this.response.redirect(path.join(this.request.path, '/posts/ic'));
  else
    this.response.redirect(path.join(this.request.path, '/posts/ooc'));
}));

app.listen(config.PORT);
console.log('Listening on ' + config.PORT);
