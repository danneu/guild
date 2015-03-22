// Node
var util = require('util');
// 3rd party
var Router = require('koa-router');
var _ = require('lodash');
var debug = require('debug')('app:routes:users');
// 1st party
var db = require('../db');
var belt = require('../belt');
var pre = require('../presenters');
var config = require('../config');
var welcomePm = require('../welcome_pm');
var cancan = require('../cancan');
var avatar = require('../avatar');
var bbcode = require('../bbcode');

var router = new Router();

////////////////////////////////////////////////////////////

//
// Edit user
//
// checked
router.get('/users/:slug/edit', function*() {
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

//
// Create new user
// - uname
// - password1
// - password2
// - email
// - g-recaptcha-response
// checked
router.post('/users', function*() {

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

//// TODO: DRY up all of these individual PUT routes
//// While I like the simplicity of individual logic per route,
//// it introduces syncing overhead between the implementations

//
// Update user role
//
// checked
router.put('/users/:slug/role', function*() {
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
router.delete('/users/:slug/legacy-sig', function*() {
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
// checked
router.put('/api/users/:id/bio', function*() {
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
// - hide-avatars
// - is-ghost
// - custom-title
// - is-grayscale
// - force-device-width
// checked
router.put('/users/:slug', function*() {
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
  if (!_.isUndefined(this.request.body['hide-avatars']))
    this.checkBody('hide-avatars').toBoolean();
  if (!_.isUndefined(this.request.body['is-ghost']))
    this.checkBody('is-ghost').toBoolean();
  if (!_.isUndefined(this.request.body['is-grayscale']))
    this.checkBody('is-grayscale').toBoolean();
  if (!_.isUndefined(this.request.body['force-device-width']))
    this.checkBody('force-device-width').toBoolean();

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
    hide_avatars: _.isBoolean(this.request.body['hide-avatars'])
                 ? this.request.body['hide-avatars']
                 : user.hide_avatars,
    is_ghost: _.isBoolean(this.request.body['is-ghost'])
                ? this.request.body['is-ghost']
                : user.is_ghost,
    is_grayscale: _.isBoolean(this.request.body['is-grayscale'])
                 ? this.request.body['is-grayscale']
                 : user.is_grayscale,
    force_device_width: _.isBoolean(this.request.body['force-device-width'])
                 ? this.request.body['force-device-width']
                 : user.force_device_width
  });
  user = pre.presentUser(user);
  this.flash = { message: ['success', 'User updated'] };
  this.response.redirect(user.url + '/edit');
});

//
// Search users
// checked
router.get('/users', function*() {
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

  this.set('X-Robots-Tag', 'noindex');

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
// Show user
//
// Legacy URLs look like /users/42
// We want to redirect those URLs to /users/some-username
// The purpose of this effort is to not break old URLs, but rather
// redirect them to the new URLs
router.get('/users/:userIdOrSlug', function*() {
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

  // TODO: Merge this query into the findUser query
  // Until then, only execute query if user's column cache indicates that
  // they actually have trophies
  var trophies = [];
  if (user.trophy_count > 0)
    trophies = yield db.findTrophiesForUserId(user.id);
  trophies = trophies.map(pre.presentTrophy);

  // FIXME: Way too many queries in this route.

  var results = yield [
    db.findLatestStatusesForUserId(user.id),
    user.current_status_id ?
      db.findStatusById(user.current_status_id) : function*(){}
  ];
  var statuses = results[0];
  user.current_status = results[1];

  // The ?before-id=_ of the "Next" button. i.e. the lowest
  // id of the posts on the current page
  var nextBeforeId = recentPosts.length > 0 ? _.last(recentPosts).id : null;

  this.set('Link', util.format('<%s>; rel="canonical"', config.HOST + user.url));

  yield this.render('show_user', {
    ctx: this,
    user: user,
    recentPosts: recentPosts,
    title: user.uname,
    trophies: trophies,
    statuses: statuses,
    // Pagination
    nextBeforeId: nextBeforeId,
    recentPostsPerPage: config.RECENT_POSTS_PER_PAGE
  });
});

//
// Show user recent topics
//
router.get('/users/:slug/recent-topics', function*() {
  // Load user
  var user;
  if (this.currUser &&
      (cancan.isStaffRole(this.currUser.role)
       || this.currUser.slug === this.params.slug))
    user = yield db.findUserWithRatingsBySlug(this.params.slug);
  else
    user = yield db.findUserBySlug(this.params.slug);
  this.assert(user, 404);
  user = pre.presentUser(user);

  // will be undefined or number
  if (this.query['before-id'])
    this.validateQuery('before-id').toInt();

  // Load recent topics
  var topics = yield db.findRecentTopicsForUserId(user.id, this.vals['before-id']);

  var nextBeforeId = topics.length > 0 ? _.last(topics).id : null;

  topics = topics.filter(function(topic) {
    return cancan.can(this.currUser, 'READ_TOPIC', topic);
  }.bind(this));
  topics = topics.map(pre.presentTopic);

  this.set('Link', util.format('<%s>; rel="canonical"', config.HOST + user.url));

  yield this.render('show_user_recent_topics', {
    ctx: this,
    user: user,
    topics: topics,
    title: user.uname,
    // Pagination
    nextBeforeId: nextBeforeId,
    topicsPerPage: 5
  });

});

//
// Delete user
//
router.delete('/users/:id', function*() {
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

// Params
// - submit: 'save' | 'delete'
// - files
//   - avatar
//     - path
router.post('/users/:slug/avatar', function*() {
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

////////////////////////////////////////////////////////////

module.exports = router;
