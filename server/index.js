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
// Users listview
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
// Canonical show-forum page
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
app.use(route.post('/forums/:forumId/topics/:topicId/posts', function*(forumId, topicId) {
  var text = this.request.body.text;
  assert(text);
  // TODO: Validation
  var post = yield db.createPost(this.currUser.id, this.request.ip, topicId, text);
  post = pre.presentPost(post);
  this.response.redirect(post.url);
}));

//
// View my PMs
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
var cancan = require('./cancan');
app.use(route.get('/convos/:convoId', function*(convoId) {
  // TODO: Authz
  var convo = yield db.findConvo(convoId);
  yield cancan.ensure.apply(this, [this.currUser, 'READ_CONVO', convo]);
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
  // TODO: Validation
  assert(title);
  assert(text);
  var topic = yield db.createTopic({
    userId: this.currUser.id,
    forumId: forumId,
    ipAddress: this.request.ip,
    title: title,
    text: text
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

//
// Update post text
//
app.use(route.put('/api/posts/:postId', function*(postId) {
  // TODO: Authz, validation
  var text = this.request.body.text;
  var updatedPost = yield db.updatePost(this.currUser.id, postId, text);
  updatedPost = pre.presentPost(updatedPost);
  this.body = JSON.stringify(updatedPost);
}));

//
// Post permalink
//
// Calculates pagination offset and redirects to
// canonical topic page since the page a post falls on depends on
// currUser. For example, members can't see most hidden posts while
// mods can.
//
app.use(route.get('/posts/:postId', function*(postId) {
  // TODO: Authz
  var post = yield db.findPostWithTopic(postId);
  if (!post) return;
  post = pre.presentPost(post);
  this.response.redirect(post.topic.url + '#post-' + post.id);
}));

//
// Canonical show-topic page
//
app.use(route.get('/forums/:forumId/topics/:topicId', function*(forumId, topicId) {
  var topic = yield db.findTopic(topicId);
  // TODO: Pagination
  var posts = yield db.findPostsByTopicId(topicId);
  topic.posts = posts;
  topic = pre.presentTopic(topic);
  yield this.render('show_topic', {
    ctx: this,
    topic: topic,
  });
}));

app.listen(config.PORT);
console.log('Listening on ' + config.PORT);
