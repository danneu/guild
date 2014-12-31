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

// Configure templating system to use `swig`
// and to find view files in `view` directory
app.use(views('../views', {
  default: 'html',  // Default extension is .html
  cache: (process.env.NODE_ENV === 'production' ? 'memory' : undefined), // consolidate bug hack
  map: { html: 'swig' }
}));

// === currUser middleware ===
// Note: Assocs `ipAddress` property. It trusts X-Proxy-* headers since the
// production site will be behind Cloudflare. (app.proxy === true)
// However, since these headers can be spoofed, ensure that the app rejects
// requests that go straight to origin (bypassing Cloudflare)
app.use(function*(next) {
  // if (this.request.headers.host === 'dev-guild.herokuapp.com') {
  //   this.body = 'Please do not connect directly to the origin server.';
  //   return;
  // }
  yield next;
});
app.use(function*(next) {
  // TODO: Implement sessions
  this.currUser = { id: 1, uname: 'foo' };
  this.currUser.ipAddress = this.request.ip;
  yield next;
});

////////////////////////////////////////////////////////////

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
    debug(category.forums);
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
  var post = yield db.createPost(this.currUser.id, this.currUser.ipAddress, topicId, text);
  post = pre.presentPost(post);
  this.response.redirect(post.url);
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
    ipAddress: this.currUser.ipAddress,
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
