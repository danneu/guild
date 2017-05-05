if (process.env.NODE_ENV === 'production') {
  // newrelic agent must load first
  require('newrelic')
}
const config = require('./config')

// Node
const fs = require('fs')
// 3rd
const Router = require('koa-router')

const Koa = require('koa')
const app = new Koa()
app.poweredBy = false
if (config.NODE_ENV === 'production') {
  app.proxy = true
}

const convert = require('koa-convert')

// static assets

app.use(convert(require('koa-better-static')('public', {
  maxage: 1000 * 60 * 60 * 24 * 365,
  gzip: false
})))

app.use(convert(require('koa-better-static')('dist', {
  maxage: 1000 * 60 * 60 * 24 * 365,
  gzip: false
})))

app.use(require('koa-conditional-get')()); // Works with koa-etag
app.use(require('koa-etag')());

// heroku already has access logger
if (config.NODE_ENV !== 'production') {
  app.use(require('koa-logger')())
}

app.use(require('koa-body')({
  multipart: true,
  // Max payload size allowed in request form body
  // Defaults to '56kb'
  // CloudFlare limits to 100mb max
  formLimit: '25mb'
}))

const nunjucksRender = convert(require('koa-nunjucks-render'))

// Node
const util = require('util')
// 3rd party
const _ = require('lodash')
const debug = require('debug')('app:index')
const assert = require('better-assert')
const compress = require('koa-compress')
// 1st party
const db = require('./db')
const pre = require('./presenters')
const middleware = require('./middleware')
const cancan = require('./cancan')
const emailer = require('./emailer')
const cache = require('./cache')
const belt = require('./belt')
const bbcode = require('./bbcode')
const bouncer = require('koa-bouncer')
require('./validation');  // Load after koa-bouncer
const akismet = require('./akismet')

app.use(middleware.methodOverride())

// Catch and log all errors that bubble up to koa
// app.on('error', function(err) {
//   log.error(err, 'Error');
//   console.error('Error:', err, err.stack);
// });

// app.use(function*(next) {
//   var start = Date.now();
//   ctx.log = log.child({ req_id: uuid.v1() });  // time-based uuid
//   ctx.log.info({ req: ctx.request }, '--> %s %s', ctx.method, ctx.path);
//   await next;
//   var diff = Date.now() - start;
//   ctx.log.info({ ms: diff, res: ctx.response },
//                 '<-- %s %s %s %s',
//                 ctx.method, ctx.path, ctx.status, diff + 'ms');
// });

// Upon app boot, check for compiled assets
// in the `dist` folder. If found, attach their
// paths to the context so the view layer can render
// them.
//
// Example value of `dist`:
// { css: 'all-ab42cf1.css', js: 'all-d181a21.js' }'
let dist;

;(() => {
  let manifest = {}
  const manifestPath = './dist/rev-manifest.json'
  if (fs.existsSync(manifestPath)) {
    const jsonString = fs.readFileSync(manifestPath, 'utf8')
    manifest = JSON.parse(jsonString)
  }
  dist = {
    css: manifest['all.css'],
    js: manifest['all.js'],
    chatjs: manifest['chat.js']
  }
  console.log('dist set', dist)
})()

// Only allow guild to be iframed from same domain
app.use(async (ctx, next) => {
  ctx.set('X-Frame-Options', 'SAMEORIGIN')
  return next()
})

app.use(async (ctx, next) => {
  ctx.dist = dist
  return next()
})

// Expose config to view layer
// TODO: use nunjucks instead of MW
app.use(async (ctx, next) => {
  ctx.config = config
  ctx.cache = cache
  return next()
})

// Remove trailing slashes from url path
app.use(async (ctx, next) => {
  // If path has more than one character and ends in a slash, then redirect to
  // the same path without that slash. Note: homepage is "/" which is why
  // we check for more than 1 char.
  if (/.+\/$/.test(ctx.request.path)) {
    const newPath = ctx.request.path.slice(0, ctx.request.path.length-1);
    ctx.status = 301
    ctx.response.redirect(newPath + ctx.request.search);
  }

  return next()
})

// TODO: Since app.proxy === true (we trust X-Proxy-* headers), we want to
// reject all requests that hit origin. app.proxy should only be turned on
// when app is behind trusted proxy like Cloudflare.

////////////////////////////////////////////////////////////

app.use(middleware.currUser())
app.use(middleware.flash())

app.use(async (ctx, next) => {  // Must become before koa-router
  ctx.can = cancan.can;
  ctx.assertAuthorized = (user, action, target) => {
    const canResult = cancan.can(user, action, target)
    // ctx.log.info('[assertAuthorized] Can %s %s: %s',
    //              (user && user.uname) || '<Guest>', action, canResult);
    debug('[assertAuthorized] Can %j %j: %j', (user && user.uname) || '<Guest>', action, canResult)
    ctx.assert(canResult, 404)
  }
  return next()
})

// Configure Nunjucks
////////////////////////////////////////////////////////////

const nunjucksOptions = {
  // `await ctx.render('show_user')` will assume that a show_user.html exists
  ext: '.html',
  noCache: config.NODE_ENV === 'development',
  // if true, throw an error if we try to {{ x }} where x is null or undefined in
  // templates. helps catch bugs and forces us to explicitly {{ x or '' }}
  throwOnUndefined: false,
  // globals are bindings we want to expose to all templates
  globals: {
    // let us use `can(USER, ACTION, TARGET)` authorization-checks in templates
    '_': _,
    belt: belt,
    cancan: cancan,
    can: cancan.can,
    config: config,
    Math: Math,
    Date: Date,
  },
  // filters are functions that we can pipe values to from nunjucks templates.
  // e.g. {{ user.uname | md5 | toAvatarUrl }}
  filters: {
    json: (s) => JSON.stringify(s, null, '  '),
    ordinalize: belt.ordinalize,
    getOrdinalSuffix: belt.getOrdinalSuffix,
    isNewerThan: belt.isNewerThan,
    expandJoinStatus: belt.expandJoinStatus,
    // {% if user.id|isIn([1, 2, 3]) %}
    isIn: (v, coll) => (coll || []).includes(v),
    // {% if things|isEmpty %}
    isEmpty: coll => _.isEmpty(coll),
    // Specifically replaces \n with <br> in user.custom_title
    replaceTitleNewlines: (str) => {
      if (!str) return '';
      return _.escape(str).replace(/\\n/, '<br>').replace(/^<br>|<br>$/g, '');
    },
    replaceTitleNewlinesMobile: (str) => {
      if (!str) return '';
      return _.escape(str).replace(/(?:\\n){2,}/, '\n').replace(/^\\n|\\n$/g, '').replace(/\\n/, ' / ');
    },
    // Sums `nums`, an array of numbers. Returns zero if `nums` is falsey.
    sum: (nums) => {
      return (nums || []).reduce((memo, n) => memo + n, 0)
    },
    // Sums the values of an object
    sumValues: (obj) => {
      return (_.values(obj)).reduce((memo, n) => memo + n, 0)
    },
    ratingTypeToImageSrc: (type) => {
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
    },
    // {{ 'firetruck'|truncate(5) }}  -> 'firet...'
    // {{ 'firetruck'|truncate(6) }}  -> 'firetruck'
    truncate: belt.makeTruncate('…'),
    // Returns distance from now to date in days. 0 or more.
    daysAgo: date => {
      return Math.floor((Date.now() - date.getTime()) / (1000*60*60*24));
    },
    // FIXME: Can't render bbcode on the fly until I speed up
    // slow bbcode like tabs
    bbcode: (markup) => {
      var html, start = Date.now();
      try {
        html = bbcode(markup);
        return html;
      } catch(ex) {
        //return 'There was a problem parsing a tag in this BBCode<br><br><pre style="overflow: auto">' + markup + '</pre>';
        throw ex;
      } finally {
        debug('bbcode render time: ', Date.now() - start, 'ms - Rendered', markup.length, 'chars');
      }
    },
    // commafy(10) -> 10
    // commafy(1000000) -> 1,000,000
    commafy: n => (n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','),
    formatDate: pre.formatDate,
    slugifyUname: belt.slugifyUname,
    presentUserRole: belt.presentUserRole,
    encodeURIComponent: s => encodeURIComponent(s),
    // String -> String
    outcomeToElement: outcome => {
      switch(outcome) {
      case 'WIN':
        return '<span class="green-glow">Win</span>';
      case 'LOSS':
        return '<span class="red-glow">Loss</span>';
      case 'DRAW':
        return '<span style="color: #999">Draw</span>';
      }
    },
    formatChatDate: belt.formatChatDate,
  }
};

app.use(convert(nunjucksRender('views', nunjucksOptions)));

////////////////////////////////////////////////////////////
// Routes //////////////////////////////////////////////////
////////////////////////////////////////////////////////////

app.use(bouncer.middleware())

app.use(async (ctx, next) => {
  try {
    await next()
  } catch (ex) {
    if (ex instanceof bouncer.ValidationError) {
      ctx.flash = {
        message: ['danger', ex.message || 'Validation error'],
        // FIXME: This breaks if body is bigger than ~4kb cookie size limit
        // i.e. large posts, large bodies of text
        params: ctx.request.body
      }
      ctx.response.redirect('back')
      return
    }
    throw ex
  }
})

// - Create middleware before this
//app.use(require('koa-router')(app))
const router = new Router()

router.post('/test', async (ctx) => {
  ctx.body = JSON.stringify(ctx.request.body, null, '  ')
})

app.use(require('./legacy_router').routes())

////////////////////////////////////////////////////////////

router.get('/search', async (ctx) => {
  // Ensure cloudsearch is configured
  ctx.assert(config.IS_CLOUDSEARCH_CONFIGURED, 400, 'Search is currently offline')

  // Must be logged in to search
  ctx.assert(ctx.currUser, 403, 'You must be logged in to search')

  // TODO: Stop hard-coding lexus lounge authorization
  const publicCategories = cache.get('categories').filter((c) => {
    return c.id !== 4
  })

  ctx.set('X-Robots-Tag', 'noindex')

  if (_.isEmpty(ctx.query)) {
    await ctx.render('search_results', {
      ctx,
      posts: [],
      searchParams: {},
      className: 'search',
      // Data that'll be serialized to DOM and read by our React components
      reactData: {
        searchParams: {},
        categories: publicCategories
      }
    })
    return
  }

  // Validate params

  ctx.validateQuery('term').trim()
  // [String]
  const unamesToIds = cache.get('unames->ids')
  ctx.validateQuery('unames')
    .toArray()
    .uniq()
    // Remove unames that aren't in our system
    .tap((unames) => {
      return unames.filter((uname) => {
        return unamesToIds[uname.toLowerCase()]
      })
    })

  const user_ids = _.chain(ctx.vals.unames).map((u) => {
    return unamesToIds[u.toLowerCase()]
  }).compact().value()

  // [String]
  ctx.validateQuery('post_types')
    .toArray();
  // String
  ctx.validateQuery('sort')
    .defaultTo(function() {
      return (ctx.vals.term ? 'relevance' : 'newest-first');
    })
    .isIn(['relevance', 'newest-first', 'oldest-first']);

  if (ctx.query.topic_id) {
    ctx.validateQuery('topic_id')
      .toInt('Topic ID must be a number')
  }
  if (ctx.query.forum_ids) {
    ctx.validateQuery('forum_ids')
      .toArray()
      .toInts('Forum IDs must be numbers');
  }

  ////////////////////////////////////////////////////////////
  // TODO: Ensure currUser is authorized to read the results

  const search = require('./search2')

  const cloudArgs = {
    term: ctx.vals.term,
    post_types: ctx.vals.post_types,
    sort: ctx.vals.sort,
    topic_id: ctx.vals.topic_id,
    forum_ids: ctx.vals.forum_ids,
    user_ids: user_ids
  };

  const cloudParams = search.buildSearchParams(cloudArgs)
  const result = await search.searchPosts(cloudArgs)

  const postIds = result.hits.hit.map((hit) => hit.id)

  const posts = await db.findPostsByIds(postIds)
    .then((xs) => xs.map(pre.presentPost))

  ////////////////////////////////////////////////////////////

  // If term was given, there will be highlight
  if (ctx.vals.term) {
    result.hits.hit.forEach((hit, idx) => {
      if (hit.highlights && posts[idx]) {
        posts[idx].highlight = hit.highlights.markup;
      }
    })
  }

  await ctx.render('search_results', {
    ctx,
    posts: posts,
    searchParams: ctx.vals,
    cloudParams: cloudParams,
    className: 'search',
    searchResultsPerPage: config.SEARCH_RESULTS_PER_PAGE,
    // Data that'll be serialized to DOM and read by our React components
    reactData: {
      searchParams: ctx.vals,
      categories: publicCategories
    }
  })
})

app.use(require('./routes/users').routes());
app.use(require('./routes/convos').routes());
app.use(require('./routes/images').routes());
app.use(require('./routes/dice').routes());
app.use(require('./routes/statuses').routes());
app.use(require('./routes/chat').routes());
app.use(require('./routes/subscriptions').routes());
app.use(require('./routes/sitemaps').routes())

// Useful to redirect users to their own profiles since canonical edit-user
// url is /users/:slug/edit

// Ex: /me/edit#grayscale-avatars to show users how to toggle that feature
router.get('/me/edit', async (ctx) => {
  // Ensure current user can edit themself
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_USER', ctx.currUser);

  // Note: Redirects fragment params
  ctx.response.redirect('/users/' + ctx.currUser.slug + '/edit');
});

////////////////////////////////////////////////////////////

router.post('/topics/:topicSlug/co-gms', async (ctx) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_CO_GMS', topic);

  ctx.validateBody('uname')
    .isString('Username required');
  var user = await db.findUserByUname(ctx.vals.uname);
  // Ensure user exists
  ctx.check(user, 'User does not exist');
  // Ensure user is not already a co-GM
  ctx.check(!topic.co_gm_ids.includes(user.id), 'User is already a co-GM');
  // Ensure user is not the GM
  ctx.check(user.id !== topic.user.id, 'User is already the GM');
  // Ensure topic has room for another co-GM
  ctx.check(topic.co_gm_ids.length < config.MAX_CO_GM_COUNT,
                'Cannot have more than ' + config.MAX_CO_GM_COUNT + ' co-GMs');

  await db.updateTopicCoGms(topic.id, [...topic.co_gm_ids, user.id])

  ctx.flash = {
    message: ['success', util.format('Co-GM added: %s', ctx.vals.uname)]
  };
  ctx.response.redirect(topic.url + '/edit#co-gms');
});

////////////////////////////////////////////////////////////

router.delete('/topics/:topicSlug/co-gms/:userSlug', async (ctx) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_CO_GMS', topic);

  var user = await db.findUserBySlug(ctx.params.userSlug);
  ctx.check(user, 'User does not exist');
  ctx.check(topic.co_gm_ids.includes(user.id), 'User is not a co-GM');

  await db.updateTopicCoGms(topic.id, topic.co_gm_ids.filter((co_gm_id) => {
    return co_gm_id !== user.id;
  }));

  ctx.flash = {
    message: ['success', util.format('Co-GM removed: %s', user.uname)]
  };
  ctx.response.redirect(topic.url + '/edit#co-gms');
});

router.get('/unames.json', async (ctx) => {
  ctx.type = 'application/json'
  ctx.body = await db.findAllUnamesJson()
});

// Required body params:
// - type: like | laugh | thank
// - post_id: Int
router.post('/posts/:postId/rate', async (ctx) => {
  try {
    ctx.validateBody('type')
      .isString('type is required')
      .trim()
      .isIn(['like', 'laugh', 'thank'], 'Invalid type');
    ctx.validateBody('post_id').toInt('Invalid post_id');
  } catch(ex) {
    if (ex instanceof bouncer.ValidationError)
      ctx.throw(ex.message, 400);
    throw ex;
  }

  var post = await db.findPostById(ctx.vals.post_id).then(pre.presentPost);

  // Ensure post exists (404)
  ctx.assert(post, 404);

  // Ensure currUser is authorized to rep (403)
  ctx.assert(cancan.can(ctx.currUser, 'RATE_POST', post), 403);

  // Ensure user has waited a certain duration since giving latest rating.
  // (To prevent rating spamming)
  var prevRating = await db.findLatestRatingForUserId(ctx.currUser.id);
  if (prevRating) {
    var threeSecondsAgo = new Date(Date.now() - 3000);
    // If this user's previous rating is newer than 3 seconds ago, fail.
    if (prevRating.created_at > threeSecondsAgo) {
      ctx.body = JSON.stringify({ error: 'TOO_SOON' });
      ctx.status = 400;
      return;
    }
  }

  // Create rep
  var rating = await db.ratePost({
    post_id: post.id,
    from_user_id: ctx.currUser.id,
    from_user_uname: ctx.currUser.uname,
    to_user_id: post.user_id,
    type: ctx.vals.type
  });

  // Send receiver a RATING notification in the background
  db.createRatingNotification({
    from_user_id: ctx.currUser.id,
    to_user_id:   post.user_id,
    post_id:      post.id,
    topic_id:     post.topic_id,
    rating_type:  rating.type
  }).catch((err) => console.error(err, err.stack))

  ctx.body = JSON.stringify(rating);
});

//
// Logout
//
router.post('/me/logout', async (ctx) => {
  if (ctx.currUser)
    await db.logoutSession(ctx.currUser.id, ctx.cookies.get('sessionId'));
  ctx.flash = { message: ['success', 'Session terminated'] };
  ctx.redirect('/');
});

//
// Login form
//
router.get('/login', async (ctx) => {
  await ctx.render('login', {
    ctx,
    title: 'Login'
  });
});

//
// Create session
//
router.post('/sessions', async (ctx) => {
  ctx.validateBody('uname-or-email').required('Invalid creds')
  ctx.validateBody('password').required('Invalid creds')
  ctx.validateBody('remember-me').toBoolean()
  var user = await db.findUserByUnameOrEmail(ctx.vals['uname-or-email'])
  ctx.check(user, 'Invalid creds')
  ctx.check(await belt.checkPassword(ctx.vals.password, user.digest), 'Invalid creds')

  // User authenticated
  var session = await db.createSession({
    userId:    user.id,
    ipAddress: ctx.request.ip,
    interval:  (ctx.vals['remember-me'] ? '1 year' : '2 weeks')
  });

  ctx.cookies.set('sessionId', session.id, {
    expires: ctx.vals['remember-me'] ? belt.futureDate({ years: 1 }) : undefined
  });
  ctx.flash = { message: ['success', 'Logged in successfully'] };
  ctx.response.redirect('/');
});

//
// BBCode Cheatsheet
//
router.get('/bbcode', async (ctx) => {
  await ctx.render('bbcode_cheatsheet', {
    ctx,
    title: 'BBCode Cheatsheet'
  });
});

//
// Registration form
//
router.get('/register', async (ctx) => {
  assert(config.RECAPTCHA_SITEKEY);
  assert(config.RECAPTCHA_SITESECRET);
  const registration = await db.keyvals.getRowByKey('REGISTRATION_ENABLED');
  await ctx.render('register', {
    ctx,
    recaptchaSitekey: config.RECAPTCHA_SITEKEY,
    registration,
    title: 'Register'
  });
});

//
// Homepage
//
router.get('/', async (ctx) => {
  const categories = cache.get('categories')

  // We don't show the mod forum on the homepage.
  // Nasty, but just delete it for now
  // TODO: Abstract
  _.remove(categories, { id: 4 })

  const categoryIds = categories.map((c) => c.id)
  const allForums = _.flatten(categories.map((c) => c.forums))

  // Assoc forum viewCount from cache
  var viewerCounts = cache.get('forum-viewer-counts');
  allForums.forEach((forum) => {
    forum.viewerCount = viewerCounts[forum.id];
  });

  var topLevelForums = _.reject(allForums, 'parent_forum_id');
  var childForums = _.filter(allForums, 'parent_forum_id');

  // Map of {CategoryId: [Forums...]}
  childForums.forEach((childForum) => {
    var parentIdx = _.findIndex(topLevelForums, { id: childForum.parent_forum_id });
    if (_.isArray(topLevelForums[parentIdx].forums))
      topLevelForums[parentIdx].forums.push(childForum);
    else
      topLevelForums[parentIdx].forums = [childForum];
  });
  var groupedTopLevelForums = _.groupBy(topLevelForums, 'category_id');
  categories.forEach((category) => {
    category.forums = (groupedTopLevelForums[category.id] || []).map(pre.presentForum);
  });

  // Get stats
  var stats = cache.get('stats');
  stats.onlineUsers.forEach(pre.presentUser);
  pre.presentUser(stats.latestUser);

  var latest_rpgn_topic = cache.get('latest-rpgn-topic') &&
                          pre.presentTopic(cache.get('latest-rpgn-topic'));

  // The unacknowledged feedback_topic for the current user
  // Will be undefined if user has no feedback to respond to
  var ftopic;
  if (config.CURRENT_FEEDBACK_TOPIC_ID && ctx.currUser) {
    ftopic = await db.findUnackedFeedbackTopic(config.CURRENT_FEEDBACK_TOPIC_ID, ctx.currUser.id);
  }

  // Get users friends for the sidebar
  var friendships;
  if (ctx.currUser) {
    friendships = await db.findFriendshipsForUserId(ctx.currUser.id, 10);
    friendships = friendships.map(pre.presentFriendship);
  }

  await ctx.render('homepage', {
    ctx,
    categories: categories,
    stats: stats,
    latest_rpgn_topic: latest_rpgn_topic,
    ftopic: ftopic,
    friendships: friendships,
    // For sidebar
    latestChecks: cache.get('latest-checks').map(pre.presentTopic),
    latestRoleplays: cache.get('latest-roleplays').map(pre.presentTopic),
    latestStatuses: cache.get('latest-statuses').map(pre.presentStatus),
    currentContest: cache.get('current-sidebar-contest')
  });
});

//
// Forgot password page
//
router.get('/forgot', async (ctx) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = 'This feature is currently disabled';
    return;
  }
  await ctx.render('forgot', {
    ctx,
    title: 'Forgot Password'
  });
});

//
//
// - Required param: email
router.post('/forgot', async (ctx) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = 'This feature is currently disabled';
    return;
  }

  var email = ctx.request.body.email;
  if (!email) {
    ctx.flash = { message: ['danger', 'You must provide an email']};
    ctx.response.redirect('/forgot');
    return;
  }
  // Check if it belongs to a user
  var user = await db.findUserByEmail(email);

  // Always send the same message on success and failure.
  var successMessage = 'Check your email';

  // Don't let the user know if the email belongs to anyone.
  // Always look like a success
  if (!user) {
    //ctx.log.info('User not found with email: %s', email);
    ctx.flash = { message: ['success', successMessage]};
    ctx.response.redirect('/');
    return;
  }

  // Don't send another email until previous reset token has expired
  if (await db.findLatestActiveResetToken(user.id)) {
    //ctx.log.info('User already has an active reset token');
    ctx.flash = { message: ['success', successMessage] };
    ctx.response.redirect('/');
    return;
  }

  var resetToken = await db.createResetToken(user.id);
  //ctx.log.info({ resetToken: resetToken }, 'Created reset token');
  // Send email in background
  //ctx.log.info('Sending email to %s', user.email);
  try {
    await emailer.sendResetTokenEmail(user.uname, user.email, resetToken.token)
  } catch (err) {
    ctx.flash = {
      message: [
        'danger',
        'For some reason, the email failed to be sent. Email me at <mahz@roleplayerguild.com> to let me know.'
      ]
    }
    ctx.redirect('back')
    return
  }

  ctx.flash = { message: ['success', successMessage] };
  ctx.response.redirect('/');
});

// Password reset form
// - This form allows a user to enter a reset token and new password
// - The email from /forgot will link the user here
router.get('/reset-password', async (ctx) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = 'This feature is currently disabled';
    return;
  }
  var resetToken = ctx.request.query.token;
  await ctx.render('reset_password', {
    ctx,
    resetToken: resetToken,
    title: 'Reset Password with Token'
  });
});

// Params
// - token
// - password1
// - password2
router.post('/reset-password', async (ctx) => {
  if (!config.IS_EMAIL_CONFIGURED) {
    ctx.body = 'This feature is currently disabled';
    return;
  }
  var token = ctx.request.body.token
  var password1 = ctx.request.body.password1
  var password2 = ctx.request.body.password2
  ctx.validateBody('remember-me').toBoolean()
  var rememberMe = ctx.vals['remember-me']

  // Check passwords
  if (password1 !== password2) {
    ctx.flash = {
      message: ['danger', 'Your new password and the new password confirmation must match'],
      params: { token: token }
    };
    return ctx.response.redirect('/reset-password?token=' + token);
  }

  // Check reset token
  var user = await db.findUserByResetToken(token);

  if (!user) {
    ctx.flash = {
      message: ['danger', 'Invalid reset token. Either you typed the token in wrong or the token expired.']
    };
    return ctx.response.redirect('/reset-password?token=' + token);
  }

  // Reset token and passwords were valid, so update user password
  await db.updateUserPassword(user.id, password1);

  // Delete user's reset tokens - They're for one-time use
  await db.deleteResetTokens(user.id);

  // Log the user in
  var interval = rememberMe ? '1 year' : '1 day';
  var session = await db.createSession({
    userId: user.id,
    ipAddress: ctx.request.ip,
    interval: interval
  });
  ctx.cookies.set('sessionId', session.id, {
    expires: belt.futureDate(new Date(), rememberMe ? { years : 1 } : { days: 1 })
  });

  ctx.flash = { message: ['success', 'Your password was updated'] };
  return ctx.response.redirect('/');
});

//
// Lexus lounge (Mod forum)
//
// The user that STAFF_REPRESENTATIVE_ID points to.
// Loaded once upon boot since env vars require reboot to update.
var staffRep;
router.get('/lexus-lounge', async (ctx) => {
  ctx.assertAuthorized(ctx.currUser, 'LEXUS_LOUNGE');

  if (!staffRep && config.STAFF_REPRESENTATIVE_ID) {
    staffRep = await db.findUser(config.STAFF_REPRESENTATIVE_ID)
      .then(pre.presentUser)
  }

  const latestUserLimit = 50

  const [latestUsers, registration, images, category] = await Promise.all([
    db.findLatestUsers(latestUserLimit).then((xs) => xs.map(pre.presentUser)),
    db.keyvals.getRowByKey('REGISTRATION_ENABLED'),
    db.images.getLatestImages(25).then((xs) => xs.map(pre.presentImage)),
    db.findModCategory()
  ])

  const forums = await db.findForums([category.id])

  category.forums = forums;
  pre.presentCategory(category) // must come after .forums assignment

  await ctx.render('lexus_lounge', {
    ctx,
    category,
    latestUsers,
    latestUserLimit,
    staffRep,
    registration,
    images,
    title: 'Lexus Lounge — Mod Forum'
  });
});

// toggle user registration on/off
router.post('/lexus-lounge/registration', async (ctx) => {
  ctx.assertAuthorized(ctx.currUser, 'LEXUS_LOUNGE');
  const enable = ctx.request.body.enable === 'true';
  await db.keyvals.setKey('REGISTRATION_ENABLED', enable, ctx.currUser.id);
  ctx.flash = { message: ['success', `Registrations ${enable ? 'enabled' : 'disabled'}`] };
  ctx.redirect('/lexus-lounge');
});

//
// Refresh forum
//
// Recalculates forum caches including the counter caches and
// the latest_post_id and latest_post_at
router.post('/forums/:forumSlug/refresh', async (ctx) => {
  // Load forum
  var forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);
  var forum = await db.findForum(forumId).then(pre.presentForum)
  ctx.assert(forum, 404);

  // Authorize user
  ctx.assertAuthorized(ctx.currUser, 'REFRESH_FORUM', forum);

  // Refresh forum
  await db.refreshForum(forum.id);

  // Redirect to homepage
  ctx.flash = {
    message: ['success', 'Forum refreshed. It may take up to 10 seconds for the changes to be reflected on the homepage.']
  };
  ctx.response.redirect('/');
});

//
// New topic form
//
router.get('/forums/:forumSlug/topics/new', async (ctx) => {
  assert(config.RECAPTCHA_SITEKEY);
  assert(config.RECAPTCHA_SITESECRET);

  // Load forum
  var forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);
  var forum = await db.findForum(forumId).then(pre.presentForum)
  ctx.assert(forum, 404);

  // Ensure user authorized to create topic in this forum
  ctx.assertAuthorized(ctx.currUser, 'CREATE_TOPIC', forum);

  // Get tag groups
  var tagGroups = forum.has_tags_enabled ? await db.findAllTagGroups() : [];

  var toArray = function(stringOrArray) {
    return _.isArray(stringOrArray) ? stringOrArray : [stringOrArray];
  };

  // Render template
  await ctx.render('new_topic', {
    ctx,
    forum: forum,
    tagGroups: tagGroups,
    is_ranked: (ctx.flash.params && ctx.flash.params.is_ranked) || false,
    postType: (ctx.flash.params && ctx.flash.params['post-type']) || 'ooc',
    initTitle: ctx.flash.params && ctx.flash.params.title,
    recaptchaSitekey: config.RECAPTCHA_SITEKEY,
    selectedTagIds: (
      ctx.flash.params
        && toArray(ctx.flash.params['tag-ids']).map(function(idStr) {
          return parseInt(idStr);
        }))
      || []
  });
});

//
// Canonical show forum
//
// @koa2
router.get('/forums/:forumSlug', async (ctx) => {
  var forumId = belt.extractId(ctx.params.forumSlug);
  ctx.assert(forumId, 404);

  ctx.validateQuery('page').optional().toInt();

  var forum = await db.findForum(forumId).then(pre.presentForum)
  ctx.assert(forum, 404);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(forum.id, forum.title);
  if (ctx.params.forumSlug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(forum.url + ctx.request.search);
    return;
  }

  ctx.assertAuthorized(ctx.currUser, 'READ_FORUM', forum);

  var pager = belt.calcPager(ctx.vals.page, 25, forum.topics_count);

  const [viewers, topics] = await Promise.all([
    db.findViewersForForumId(forum.id),
    // Avoids the has_posted subquery if guest
    ctx.currUser
      ? db.findTopicsWithHasPostedByForumId(
          forumId, pager.limit, pager.offset, ctx.currUser.id
        )
      : db.findTopicsByForumId(forumId, pager.limit, pager.offset)
  ])

  // If arena, then expose the mini arena leaderboard
  let arenaLeaderboard
  if (forum.is_arena_rp || (forum.parent_forum && forum.parent_forum.is_arena_rp)) {
    arenaLeaderboard = cache.get('arena-leaderboard')
  }

  forum.topics = topics
  pre.presentForum(forum)

  // update viewers in background
  db.upsertViewer(ctx, forum.id)
    .catch((err) => console.error(err, err.stack))

  await ctx.render('show_forum', {
    ctx,
    forum,
    currPage: pager.currPage,
    totalPages: pager.totalPages,
    title: forum.title,
    className: 'show-forum',
    arenaLeaderboard: arenaLeaderboard,
    // Viewers
    viewers
  });
});

//
// Create post
// Body params:
// - post-type
// - markup
//
router.post('/topics/:topicSlug/posts', middleware.ratelimit(), /* middleware.ensureRecaptcha, */ async (ctx) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);

  ctx.validateBody('post-type').isIn(['ic', 'ooc', 'char'], 'Invalid post-type');
  ctx.validateBody('markup')
    .isLength(config.MIN_POST_LENGTH,
              config.MAX_POST_LENGTH,
              'Post must be between ' +
              config.MIN_POST_LENGTH + ' and ' +
              config.MAX_POST_LENGTH + ' chars long. Yours was ' +
              ctx.request.body.markup.length);

  var postType = ctx.vals['post-type'];
  var topic = await db.findTopic(topicId);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'CREATE_POST', topic);

  // If non-rp forum, then the post must be 'ooc' type
  if (!topic.forum.is_roleplay)
    ctx.assert(postType === 'ooc', 400);

  // Check post against akismet
  if (ctx.currUser.posts_count <= 5) {
    const isSpam = await Promise.race([
      belt.timeout(10000).then(() => false),
      akismet.checkComment({
        commentType: 'reply',
        commentAuthor: ctx.currUser.uname,
        commentEmail: ctx.currUser.email,
        commentContent: ctx.vals.markup,
        userIp: ctx.ip,
        userAgent: ctx.headers['user-agent']
      })
    ]).catch((err) => {
      // On error, just let them post
      console.error('akismet error', err)
      return false
    })

    if (isSpam) {
      await db.nukeUser({
        spambot: ctx.currUser.id,
        nuker: config.STAFF_REPRESENTATIVE_ID || 1
      })
      emailer.sendAutoNukeEmail(ctx.currUser.slug, ctx.vals.markup)
      ctx.redirect('/')
      return
    }
  }

  // Render the bbcode
  var html = bbcode(ctx.vals.markup);

  var post = await db.createPost({
    userId: ctx.currUser.id,
    ipAddress: ctx.request.ip,
    topicId: topic.id,
    markup: ctx.vals.markup,
    html: html,
    type: postType,
    isRoleplay: topic.forum.is_roleplay
  }).then(pre.presentPost)

  // Send MENTION and QUOTE notifications
  var results = await Promise.all([
    db.parseAndCreateMentionNotifications({
      fromUser: ctx.currUser,
      markup: ctx.vals.markup,
      post_id: post.id,
      topic_id: post.topic_id
    }),
    db.parseAndCreateQuoteNotifications({
      fromUser: ctx.currUser,
      markup: ctx.vals.markup,
      post_id: post.id,
      topic_id: post.topic_id
    })
  ]);

  var mentionNotificationsCount = results[0].length;
  var quoteNotificationsCount = results[1].length;

  ctx.flash = {
    message: [
      'success',
      util.format('Post created. Mentions sent: %s, Quotes sent: %s',
                  mentionNotificationsCount, quoteNotificationsCount)]
  };

  ctx.response.redirect(post.url);
});

// (AJAX)
// Delete specific notification
router.del('/api/me/notifications/:id', async (ctx) => {
  ctx.validateParam('id');
  var n = await db.findNotificationById(ctx.vals.id);
  // Ensure exists
  ctx.assert(n, 404);
  // Ensure user authorized;
  ctx.assert(cancan.can(ctx.currUser, 'DELETE_NOTIFICATION', n), 403);
  // Delete it
  await db.deleteNotificationForUserIdAndId(ctx.currUser.id, n.id);
  // Return success
  ctx.status = 200;
});

// Delete many notifications
//
// Required body params:
// ids: [Integer] - The notification ids to delete
//   - May contain `-1` to force the array from the form
//     Anything non-positive will simply be filtered out first
//   - The purpose of passing in notifications ids instead of just
//     clearing all of a user's notifications is so that clicking the
//     "clear notifications" button only deletes the notifications the
//     user has on screen and not any notifications they may've received
//     in the meantime.
router.del('/me/notifications', async (ctx) => {

  ctx.validateBody('ids')
    .toInts()
    .tap(function(ids) {
      debug(ids);
      return ids.filter(function(n) { return n > 0; });
    });

  // Ensure a user is logged in
  ctx.assert(ctx.currUser, 404);

  await db.clearNotifications(ctx.currUser.id, ctx.vals.ids);

  ctx.flash = { message: ['success', 'Notifications cleared'] };
  var redirectTo = ctx.request.body['redirect-to'] || '/me/notifications';
  ctx.response.redirect(redirectTo);
});

// Delete only convo notifications
router.delete('/me/notifications/convos', async (ctx) => {
  // Ensure a user is logged in
  ctx.assert(ctx.currUser, 404);
  await db.clearConvoNotifications(ctx.currUser.id);
  ctx.flash = {
    message: ['success', 'PM notifications cleared']
  };
  ctx.response.redirect('/me/convos');
});

//
// Update topic tags
// - tag-ids: Required [StringIds]
//
router.put('/topics/:topicSlug/tags', async (ctx) => {
  // Load topic
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic)
  ctx.assert(topic, 404);

  // Authorize user
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_TAGS', topic);

  // Validate body params
  ctx.validateBody('tag-ids')
    .toInts()
    .uniq()
    .tap(function(ids) {
      return ids.filter(function(n) {
        return n > 0;
      });
    })
    .isLength(1, 5, 'Must select 1-5 tags');

  // Add this forum's tag_id if it has one
  var tagIds = _.chain(ctx.vals['tag-ids'])
    .concat(topic.forum.tag_id ? [topic.forum.tag_id] : [])
    .uniq()
    .value();

  // Update topic
  await db.updateTopicTags(topic.id, tagIds);

  ctx.flash = { message: ['success', 'Tags updated'] };
  ctx.response.redirect(topic.url + '/edit');
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
router.post('/forums/:slug/topics', middleware.ratelimit(), /* middleware.ensureRecaptcha, */ async (ctx) => {
  var forumId = belt.extractId(ctx.params.slug);
  ctx.assert(forumId, 404);

  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);

  // Load forum
  var forum = await db.findForumById(forumId).then(pre.presentForum)

  // Ensure forum exists
  ctx.assert(forum, 404);

  // Check user authorization
  ctx.assertAuthorized(ctx.currUser, 'CREATE_TOPIC', forum);

  // Validate params
  ctx.validateBody('title')
    .isString('Title is required')
    .trim()
    .isLength(config.MIN_TOPIC_TITLE_LENGTH,
              config.MAX_TOPIC_TITLE_LENGTH,
              'Title must be between ' +
              config.MIN_TOPIC_TITLE_LENGTH + ' and ' +
              config.MAX_TOPIC_TITLE_LENGTH + ' chars');
  ctx.validateBody('markup')
    .isString('Post is required')
    .trim()
    .isLength(config.MIN_POST_LENGTH,
              config.MAX_POST_LENGTH,
              'Post must be between ' +
              config.MIN_POST_LENGTH + ' and ' +
              config.MAX_POST_LENGTH + ' chars');
  ctx.validateBody('forum-id')
    .toInt()

  if (forum.is_arena_rp) {
    ctx.validateBody('is_ranked')
      .tap((x) => x === 'on')
  } else {
    ctx.vals.is_ranked = false;
    // ctx.check(_.isUndefined(ctx.request.body.is_ranked),
    //            'You may only specify Ranked vs Unranked for Arena Roleplays');
  }

  if (forum.is_roleplay) {
    ctx.validateBody('post-type')
      .isIn(['ooc', 'ic'], 'post-type must be "ooc" or "ic"');
    ctx.validateBody('join-status')
      .isIn(['jump-in', 'apply', 'full'], 'Invalid join-status');
  }

  // Validate tags (only for RPs/Checks
  if (forum.has_tags_enabled) {
    ctx.validateBody('tag-ids')
      .toArray()
      .toInts()
      .tap((ids) => {  // One of them will be -1
        return ids.filter((n) => n > 0)
      })
      .isLength(1, 5, 'Must select 1-5 tags');
  }
  ctx.validateBody('tag-ids').defaultTo([]);

  // Validation succeeded

  // Check topic against akismet
  if (ctx.currUser.posts_count <= 5) {
    const isSpam = await Promise.race([
      belt.timeout(10000).then(() => false),
      akismet.checkComment({
        commentType: 'forum-post',
        commentAuthor: ctx.currUser.uname,
        commentEmail: ctx.currUser.email,
        commentContent: ctx.vals.markup,
        userIp: ctx.ip,
        userAgent: ctx.headers['user-agent']
      })
    ]).catch((err) => {
      // On error, just let them post
      console.error('akismet error', err)
      return false
    })

    if (isSpam) {
      await db.nukeUser({
        spambot: ctx.currUser.id,
        nuker: config.STAFF_REPRESENTATIVE_ID || 1
      })
      emailer.sendAutoNukeEmail(ctx.currUser.slug, ctx.vals.markup)
      ctx.redirect('/')
      return
    }
  }

  // Render BBCode to html
  var html = bbcode(ctx.vals.markup);

  // post-type is always ooc for non-RPs
  var postType = forum.is_roleplay ? ctx.vals['post-type'] : 'ooc';

  var tagIds = _.chain(ctx.vals['tag-ids'])
    .concat(forum.tag_id ? [forum.tag_id] : [])
    .uniq()
    .value();

  // Create topic
  var topic = await db.createTopic({
    userId: ctx.currUser.id,
    forumId: forumId,
    ipAddress: ctx.request.ip,
    title: ctx.vals.title,
    markup: ctx.vals.markup,
    html: html,
    postType: postType,
    isRoleplay: forum.is_roleplay,
    tagIds: tagIds,
    joinStatus: ctx.vals['join-status'],
    is_ranked: ctx.vals.is_ranked
  }).then(pre.presentTopic);
  ctx.response.redirect(topic.url);
});

// Edit post form
// - The "Edit" button on posts links here so that people without
// javascript or poor support for javascript will land on a basic edit-post
// form that does not depend on javascript.
router.get('/posts/:id/edit', async (ctx) => {
  // Short-circuit if user isn't logged in
  ctx.assert(ctx.currUser, 403);

  // Load the post
  var post = await db.findPostById(ctx.params.id).then(pre.presentPost)

  // 404 if it doesn't exist
  ctx.assert(post, 404);

  // Ensure current user is authorized to edit the post
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_POST', post);

  await ctx.render('edit_post', {
    ctx,
    post: post
  });
});

// See and keep in sync with GET /posts/:id/edit
router.get('/pms/:id/edit', async (ctx) => {
  // Short-circuit if user isn't logged in
  ctx.assert(ctx.currUser, 403);

  // Load the resource
  var pm = await db.findPmById(ctx.params.id).then(pre.presentPm);

  // 404 if it doesn't exist
  ctx.assert(pm, 404);

  // Ensure current user is authorized to edit it
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_PM', pm);

  await ctx.render('edit_pm', {
    ctx,
    pm: pm
  });
});

//
// Update post markup (via from submission)
// This is for the /posts/:id/edit basic form made
// for people on devices where the Edit button doesn't work.
//
// Params: markup
router.put('/posts/:id', async (ctx) => {
  ctx.validateBody('markup')
     .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH)

  var post = await db.findPostById(ctx.params.id)
  ctx.assert(post, 404)
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_POST', post)

  // Render BBCode to html
  const html = bbcode(ctx.vals.markup)

  const updatedPost = await db.updatePost(ctx.params.id, ctx.vals.markup, html)
    .then(pre.presentPost)

  ctx.response.redirect(updatedPost.url);
});

// See and keep in sync with PUT /posts/:id
// Params: markup
router.put('/pms/:id', async (ctx) => {
  ctx.validateBody('markup')
     .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH)

  var pm = await db.findPmById(ctx.params.id);
  ctx.assert(pm, 404);
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_PM', pm);

  // Render BBCode to html
  var html = bbcode(ctx.vals.markup);

  var updatedPm = await db.updatePm(ctx.params.id, ctx.vals.markup, html)
    .then(pre.presentPm)

  ctx.response.redirect(updatedPm.url);
});

//
// Post markdown view
//
// Returns the unformatted post source.
//
router.get('/posts/:id/raw', async (ctx) => {
  var post = await db.findPostWithTopicAndForum(ctx.params.id);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_POST', post);
  ctx.set('Cache-Control', 'no-cache');
  ctx.set('X-Robots-Tag', 'noindex');
  ctx.body = post.markup ? post.markup : post.text;
});

router.get('/pms/:id/raw', async (ctx) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.assert(ctx.currUser, 404);
  var pm = await db.findPmWithConvo(ctx.params.id);
  ctx.assert(pm, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_PM', pm);
  ctx.set('Cache-Control', 'no-cache');
  ctx.body = pm.markup ? pm.markup : pm.text;
});

//
// Update post markup
// Body params:
// - markup
//
// Keep /api/posts/:postId and /api/pms/:pmId in sync
router.put('/api/posts/:id', async (ctx) => {
  ctx.validateBody('markup')
     .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH)

  var post = await db.findPost(ctx.params.id);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_POST', post);

  // Render BBCode to html
  var html = bbcode(ctx.request.body.markup);

  var updatedPost = await db.updatePost(ctx.params.id, ctx.vals.markup, html)
    .then(pre.presentPost)
  ctx.body = JSON.stringify(updatedPost);
});

router.put('/api/pms/:id', async (ctx) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.validateBody('markup')
     .isLength(config.MIN_POST_LENGTH, config.MAX_POST_LENGTH);

  // Users that aren't logged in can't read any PMs, so just short-circuit
  // if user is a guest so we don't even incur DB query.
  ctx.assert(ctx.currUser, 404);

  var pm = await db.findPmWithConvo(ctx.params.id);

  // 404 if there is no PM with this ID
  ctx.assert(pm, 404);

  // Ensure user is allowed to update this PM
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_PM', pm);

  // Render BBCode to html
  var html = bbcode(ctx.vals.markup);

  var updatedPm = await db.updatePm(ctx.params.id, ctx.vals.markup, html)
    .then(pre.presentPm)

  ctx.body = JSON.stringify(updatedPm);
});

//
// Update topic status
// Params
// - status (Required) String, one of STATUS_WHITELIST
//
router.put('/topics/:topicSlug/status', async (ctx) => {
  var topicId = belt.extractId(ctx.params.topicSlug);
  ctx.assert(topicId, 404);
  var STATUS_WHITELIST = ['stick', 'unstick', 'hide', 'unhide', 'close', 'open'];
  var status = ctx.request.body.status;
  ctx.assert(STATUS_WHITELIST.includes(status), 400, 'Invalid status');
  var topic = await db.findTopic(topicId);
  ctx.assert(topic, 404);
  var action = status.toUpperCase() + '_TOPIC';
  ctx.assertAuthorized(ctx.currUser, action, topic);
  await db.updateTopicStatus(topicId, status);
  ctx.flash = { message: ['success', 'Topic updated'] };
  pre.presentTopic(topic);
  ctx.response.redirect(topic.url);
});

// Update post state
router.post('/posts/:postId/:status', async (ctx) => {
  var STATUS_WHITELIST = ['hide', 'unhide'];
  ctx.assert(STATUS_WHITELIST.includes(ctx.params.status), 400,
              'Invalid status');
  ctx.assert(ctx.currUser, 403);
  var post = await db.findPost(ctx.params.postId);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser,
                        ctx.params.status.toUpperCase() + '_POST',
                        post);
  var updatedPost = await db.updatePostStatus(ctx.params.postId, ctx.params.status)
    .then(pre.presentPost)

  ctx.response.redirect(updatedPost.url);
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
router.get('/posts/:postId', async (ctx) => {
  var post = await db.findPostWithTopicAndForum(ctx.params.postId);
  ctx.assert(post, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_POST', post);
  post = pre.presentPost(post);

  // Determine the topic url and page for this post
  var redirectUrl;
  if (post.idx < config.POSTS_PER_PAGE)
    redirectUrl = post.topic.url + '/' + post.type + '#post-' + post.id;
  else
    redirectUrl = post.topic.url + '/' + post.type +
                  '?page=' +
                  Math.ceil((post.idx + 1) / config.POSTS_PER_PAGE) +
                  '#post-' + post.id;

  if (ctx.currUser) {
    // Delete notifications related to this post
    var notificationsDeletedCount = await db.deleteNotificationsForPostId(
      ctx.currUser.id,
      ctx.params.postId
    );
    // Update the stale user
    ctx.currUser.notifications_count -= notificationsDeletedCount;
  }

  ctx.status = 301;
  ctx.response.redirect(redirectUrl);
});

// PM permalink
// Keep this in sync with /posts/:postId
router.get('/pms/:id', async (ctx) => {
  if (!config.IS_PM_SYSTEM_ONLINE) {
    ctx.body = 'PM system currently disabled';
    return;
  }

  ctx.assert(ctx.currUser, 404);
  var id = ctx.params.id;
  var pm = await db.findPmWithConvo(id);
  ctx.assert(pm, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_PM', pm);

  pm = pre.presentPm(pm);

  var redirectUrl;
  if (pm.idx < config.POSTS_PER_PAGE)
    redirectUrl = pm.convo.url + '#post-' + pm.id;
  else
    redirectUrl = pm.convo.url + '?page=' +
                  Math.max(1, Math.ceil((pm.idx + 1) / config.POSTS_PER_PAGE)) +
                  '#post-' + pm.id;

  ctx.status = 301;
  ctx.response.redirect(redirectUrl);
});

//
// Show topic edit form
// For now it's just used to edit topic title
// Ensure this comes before /topics/:slug/:xxx so that "edit" is not
// considered the second param
//
router.get('/topics/:slug/edit', async (ctx) => {
  ctx.assert(ctx.currUser, 403);
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId).then(pre.presentTopic)
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC', topic);

  // Get tag groups
  var tagGroups = await db.findAllTagGroups();

  // Arena outcomes
  var arenaOutcomes = [];
  if (topic.forum.is_arena_rp) {
    arenaOutcomes = await db.findArenaOutcomesForTopicId(topic.id)
      .then((xs) => xs.map(pre.presentArenaOutcome))
  }

  await ctx.render('edit_topic', {
    ctx,
    topic,
    selectedTagIds: (topic.tags || []).map((tag) => tag.id),
    tagGroups: tagGroups,
    arenaOutcomes: arenaOutcomes,
    className: 'edit-topic'
  });
});

// Update topic
// Params:
// - title Required
router.put('/topics/:slug/edit', async (ctx) => {

  // Authorization
  ctx.assert(ctx.currUser, 403);
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId);
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_TITLE', topic);

  // Parameter validation

  try {

    if (ctx.request.body.title) {
      ctx.assert(cancan.can(ctx.currUser, 'UPDATE_TOPIC_TITLE', topic));
      ctx.validateBody('title')
        .defaultTo(topic.title)
        .isLength(config.MIN_TOPIC_TITLE_LENGTH,
                  config.MAX_TOPIC_TITLE_LENGTH,
                  'Title must be ' +
                  config.MIN_TOPIC_TITLE_LENGTH + ' - ' +
                  config.MAX_TOPIC_TITLE_LENGTH + ' chars long');
    }

    if (ctx.request.body['join-status']) {
      ctx.assert(cancan.can(ctx.currUser, 'UPDATE_TOPIC_JOIN_STATUS', topic));
      ctx.validateBody('join-status')
        .defaultTo(topic.join_status)
        .isIn(['jump-in', 'apply', 'full'], 'Invalid join-status');
    }

  } catch(ex) {
    if (ex instanceof bouncer.ValidationError) {
      ctx.flash = {
        message: ['danger', ex.message],
        params: ctx.request.body
      };
      ctx.response.redirect(topic.url + '/edit');
      return;
    }
    throw ex;
  }

  // Validation succeeded, so update topic
  await db.updateTopic(topic.id, {
    title: ctx.vals.title,
    join_status: ctx.vals['join-status']
  });

  ctx.flash = { message: ['success', 'Topic updated'] };
  ctx.response.redirect(topic.url + '/edit');
});

// Go to first unread post in a topic
router.get('/topics/:slug/:postType/first-unread', async (ctx) => {
  // This page should not be indexed
  ctx.set('X-Robots-Tag', 'noindex');

  // Load topic
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);

  var topic;
  if (ctx.currUser) {
    topic = await db.findTopicWithIsSubscribed(ctx.currUser.id, topicId);
  } else {
    topic = await db.findTopicById(topicId);
  }
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);

  // If user is not logged in, just go to first page
  if (!ctx.currUser) {
    return ctx.redirect(topic.url);
  }

  var postId = await db.findFirstUnreadPostId({
    topic_id: topic.id,
    user_id: ctx.currUser.id,
    post_type: ctx.params.postType
  });

  if (postId)
    ctx.redirect('/posts/' + postId);
  else
    ctx.redirect(topic.url + '/' + ctx.params.postType);
});

//
// Promote an arena roleplay to ranked
//
router.post('/topics/:slug/promote-to-ranked', async (ctx) => {
  // Load topic
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId);
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);

  // Check currUser authorization
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_ARENA_OUTCOMES', topic);

  await db.promoteArenaRoleplayToRanked(topic.id);

  ctx.redirect(topic.url + '/edit#arena-outcome');

});

//
// Delete arena outcome
//
router.del('/topics/:slug/arena-outcomes', async (ctx) => {
  // Load topic
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId);
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);

  // Check currUser authorization
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_ARENA_OUTCOMES', topic);

  // Ensure topic is ranked
  ctx.assert(topic.is_ranked, 404);

  // Validation
  ctx.validateBody('outcome_id').toInt();

  // Create arena outcome
  await db.deleteArenaOutcome(topic.id, ctx.vals.outcome_id);

  ctx.flash = { message: ['success', 'Arena outcome deleted'] };
  ctx.redirect(topic.url + '/edit');
});

//
// Add arena outcome
//
router.post('/topics/:slug/arena-outcomes', async (ctx) => {

  // Load topic
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);
  var topic = await db.findTopicById(topicId);
  ctx.assert(topic, 404);
  topic = pre.presentTopic(topic);

  // Check currUser authorization
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TOPIC_ARENA_OUTCOMES', topic);

  // Ensure topic is ranked
  ctx.assert(topic.is_ranked, 404);

  // Validation
  ctx.validateBody('uname')
    .isString()
  ctx.validateBody('outcome')
    .isIn(['WIN', 'LOSS', 'DRAW'])

  // Validate that uname belongs to a user
  var user = await db.findUserByUname(ctx.vals.uname);
  ctx.validateBody('uname')
    .check(user, 'User not found with username: "' + ctx.vals.uname + '"');

  // Create arena outcome
  var ao = await db.createArenaOutcome(topic.id, user.id, ctx.vals.outcome, ctx.currUser.id);

  ctx.flash = { message: ['success', 'Arena outcome added'] };
  ctx.redirect(topic.url + '/edit');
});

//
// Canonical show topic
//

router.get('/topics/:slug/:postType', async (ctx) => {
  ctx.assert(['ic', 'ooc', 'char'].includes(ctx.params.postType), 404);
  ctx.validateQuery('page').optional().toInt();
  const topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);

  // If ?page=1 was given, then redirect without param
  // since page 1 is already the canonical destination of a topic url
  if (ctx.vals.page === 1) {
    ctx.status = 301;
    return ctx.response.redirect(ctx.request.path);
  }

  var page = Math.max(1, ctx.request.query.page || 1);

  // Only incur the topic_subscriptions join if currUser exists
  var topic;
  if (ctx.currUser) {
    topic = await db.findTopicWithIsSubscribed(ctx.currUser.id, topicId);
  } else {
    topic = await db.findTopicById(topicId);
  }
  ctx.assert(topic, 404);

  topic = pre.presentTopic(topic);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (ctx.params.slug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(topic.url + ctx.request.search);
    return;
  }

  // If user tried to go to ic/char tabs on a non-rp, then 404
  if (!topic.is_roleplay)
    ctx.assert(!['ic', 'char'].includes(ctx.params.postType), 404);

  ctx.assertAuthorized(ctx.currUser, 'READ_TOPIC', topic);

  var totalItems = topic[ctx.params.postType + '_posts_count'];
  var totalPages = belt.calcTotalPostPages(totalItems);

  // Don't need this page when post pages are pre-calc'd in the database
  // var pager = belt.calcPager(page, config.POSTS_PER_PAGE, totalItems);

  // Redirect to the highest page if page parameter exceeded it
  if (page > totalPages) {
    var redirectUrl = page === 1 ? ctx.request.path :
                                   ctx.request.path + '?page=' + totalPages;
    return ctx.response.redirect(redirectUrl);
  }

  // Get viewers and posts in parallel
  const [viewers, posts] = await Promise.all([
    db.findViewersForTopicId(topic.id),
    db.findPostsByTopicId(topicId, ctx.params.postType, page)
  ])

  if (ctx.currUser) {
    posts.forEach((post) => {
      var rating = post.ratings.find((x) => x.from_user_id === ctx.currUser.id)
      post.has_rated = rating
    })
  }

  // Update watermark
  if (ctx.currUser && posts.length > 0) {
    await db.updateTopicWatermark({
      topic_id: topic.id,
      user_id: ctx.currUser.id,
      post_type: ctx.params.postType,
      post_id: _.last(posts).id
    });
  }

  // If we're on the last page, remove the unread button
  // Since we update the watermark in the background, the find-topic
  // query doesn't consider this page read yet
  if (page === totalPages) {
    topic['unread_' + ctx.params.postType] = false;
  }

  topic.posts = posts.map(pre.presentPost);
  var postType = ctx.params.postType;

  // update viewers in background
  db.upsertViewer(ctx, topic.forum_id, topic.id)
    .catch((err) => console.error(err, err.stack))

  await ctx.render('show_topic', {
    ctx,
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
    viewers: viewers,
    recaptchaSitekey: config.RECAPTCHA_SITEKEY
  });
});

// Legacy URL
// Redirect to the new, shorter topic URL
router.get('/topics/:topicId/posts/:postType', async (ctx) => {
  var redirectUrl = '/topics/' + ctx.params.topicId + '/' + ctx.params.postType;
  ctx.status = 301;
  ctx.response.redirect(redirectUrl);
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
router.get('/topics/:slug', async (ctx) => {
  var topicId = belt.extractId(ctx.params.slug);
  ctx.assert(topicId, 404);

  var topic = await db.findTopic(topicId);
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'READ_TOPIC', topic);

  topic = pre.presentTopic(topic);

  // Redirect to canonical slug
  var expectedSlug = belt.slugify(topic.id, topic.title);
  if (ctx.params.slug !== expectedSlug) {
    ctx.status = 301;
    ctx.response.redirect(topic.url + ctx.request.search);
    return;
  }

  // TODO: Should these be 301?
  if (topic.forum.is_roleplay)
    if (topic.ic_posts_count > 0)
      ctx.response.redirect(ctx.request.path + '/ic');
    else
      ctx.response.redirect(ctx.request.path + '/ooc');
  else
    ctx.response.redirect(ctx.request.path + '/ooc');
});

//
// Staff list
//
router.get('/staff', async (ctx) => {
  const users = cache.get('staff').map(pre.presentUser)

  await ctx.render('staff', {
    ctx,
    mods: users.filter((u) => u.role === 'mod'),
    smods: users.filter((u) => u.role === 'smod'),
    conmods: users.filter((u) => u.role === 'conmod'),
    admins: users.filter((u) => u.role === 'admin'),
    arena_mods: users.filter((u) => u.roles.includes('ARENA_MOD'))
  });
});

//
// GET /me/notifications
// List currUser's notifications
//
router.get('/me/notifications', async (ctx) => {
  ctx.assert(ctx.currUser, 404);
  const notifications = await db.findReceivedNotificationsForUserId(ctx.currUser.id)
    .then((xs) => xs.map(pre.presentNotification))

  await ctx.render('me_notifications', {
    ctx,
    notifications
  });
});

//
// Move topic
//
router.post('/topics/:slug/move', async (ctx) => {
  const topicId = belt.extractId(ctx.params.slug);
  let topic = await db.findTopicById(topicId).then(pre.presentTopic)
  ctx.assert(topic, 404);
  ctx.assertAuthorized(ctx.currUser, 'MOVE_TOPIC', topic);

  // Validation

  ctx.validateBody('forum-id')
    .toInt('forum-id required')
    .notEq(topic.forum_id, 'Topic already belongs to the forum you tried to move it to');
  console.log('redire', ctx.request.body)
  ctx.validateBody('leave-redirect?')
    .tap((x) => x === 'on')

  topic = await db.moveTopic(
    topic.id,
    topic.forum_id,
    ctx.vals['forum-id'],
    ctx.vals['leave-redirect?']
  ).then(pre.presentTopic)

  ctx.flash = {
    message: ['success', 'Topic moved']
  };

  ctx.response.redirect(topic.url);
});

//
// Delete currUser's rating for a post
//
router.delete('/me/ratings/:postId', async (ctx) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);
  var rating = await db.findRatingByFromUserIdAndPostId(
    ctx.currUser.id, ctx.params.postId
  );
  // Ensure rating exists
  ctx.assert(rating, 404);

  // Ensure rating was created within 30 seconds
  var thirtySecondsAgo = new Date(Date.now() - 1000 * 30);
  // If this user's previous rating is newer than 30 seconds ago, fail.
  if (rating.created_at < thirtySecondsAgo) {
    ctx.status = 400;
    ctx.body = 'You cannot delete a rating that is older than 30 seconds';
    return;
  }

  await db.deleteRatingByFromUserIdAndPostId(
    ctx.currUser.id, ctx.params.postId
  );

  ctx.response.redirect('/posts/' + ctx.params.postId);
});

router.get('/ips/:ip_address', async (ctx) => {
  // Ensure authorization
  ctx.assertAuthorized(ctx.currUser, 'LOOKUP_IP_ADDRESS');

  const [postsTable, pmsTable] = await Promise.all([
    db.findUsersWithPostsWithIpAddress(ctx.params.ip_address),
    db.findUsersWithPmsWithIpAddress(ctx.params.ip_address)
  ])

  await ctx.render('show_users_with_ip_address', {
    ctx,
    ip_address: ctx.params.ip_address,
    postsTable,
    pmsTable
  })
})

//
// Show user ip addresses
//
router.get('/users/:slug/ips', async (ctx) => {
  // Load user
  var user = await db.findUserBySlug(ctx.params.slug);
  ctx.assert(user, 404);

  // Authorize currUser
  ctx.assertAuthorized(ctx.currUser, 'READ_USER_IP', user);

  // Load ip addresses
  var ip_addresses = await db.findAllIpAddressesForUserId(user.id);

  ctx.set('Content-Type', 'text/html');
  ctx.body = _.isEmpty(ip_addresses) ?
    'None on file'
    : ip_addresses.map(function(ip_address) {
      return '<a href="/ips/' + ip_address + '">' + ip_address + '</a>';
    }).join('<br>');
});

////////////////////////////////////////////////////////////

router.get('/trophies', async (ctx) => {
  ctx.body = 'TODO';
});

// List all trophy groups
router.get('/trophy-groups', async (ctx) => {
  var groups = await db.findTrophyGroups();

  await ctx.render('list_trophy_groups', {
    ctx,
    groups: groups
  });
});

// Create trophy group
router.post('/trophy-groups', async (ctx) => {
  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'CREATE_TROPHY_GROUP');

  ctx.validateBody('title')
    .isString('Title required')
    .trim()
    .isLength(3, 50, 'Title must be 3-50 chars');

  ctx.validateBody('description-markup');
  if (ctx.request.body['description-markup']) {
    ctx.validateBody('description-markup')
      .trim()
      .isLength(3, 3000, 'Description must be 3-3000 chars');
  }

  var description_html;
  if (ctx.vals['description-markup']) {
    description_html = bbcode(ctx.vals['description-markup']);
  }

  var group = await db.createTrophyGroup(
    ctx.vals.title,
    ctx.vals['description-markup'],
    description_html
  );

  ctx.flash = { message: ['success', 'Trophy group created'] };
  ctx.redirect('/trophy-groups');
});

// Update trophy-group
router.put('/trophy-groups/:id', async (ctx) => {
  // Load
  var group = await db.findTrophyGroupById(ctx.params.id);
  ctx.assert(group, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TROPHY_GROUP', group);

  ctx.validateParam('id').toInt();

  ctx.validateBody('title')
    .isString('Title required')
    .trim()
    .isLength(3, 50, 'Title must be 3-50 chars');

  ctx.validateBody('description-markup');
  if (ctx.request.body['description-markup']) {
    ctx.validateBody('description-markup')
      .trim()
      .isLength(3, 3000, 'Description must be 3-3000 chars');
  }

  var description_html;
  if (ctx.vals['description-markup']) {
    description_html = bbcode(ctx.vals['description-markup']);
  }

  await db.updateTrophyGroup(
    ctx.vals.id,
    ctx.vals.title,
    ctx.vals['description-markup'],
    description_html
  );

  ctx.redirect('/trophy-groups/' + group.id);
});

// Delete active trophy
router.del('/users/:user_id/active-trophy', async (ctx) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);

  ctx.validateParam('user_id').toInt();

  // Ensure currUser is only trying to operate on themselves
  // TODO: Make cancan.js rule
  ctx.assert(ctx.currUser.id === ctx.vals.user_id, 403);

  // Ensure user exists
  const user = await db.findUserById(ctx.vals.user_id).then(pre.presentUser)
  ctx.assert(user, 404);

  // Deactivate trophy
  await db.deactivateCurrentTrophyForUserId(ctx.vals.user_id);

  // Redirect
  ctx.flash = { message: ['success', 'Trophy deactivated'] };
  ctx.redirect(user.url);
});

// Update user active_trophy_id
//
// Body:
// - trophy_id: Required Int
router.put('/users/:user_id/active-trophy', async (ctx) => {
  // Ensure user is logged in
  ctx.assert(ctx.currUser, 403);

  ctx.validateParam('user_id').toInt();
  ctx.validateBody('trophy_id')
    .isString('trophy_id required')
    .toInt();

  // Ensure user exists
  const user = await db.findUserById(ctx.vals.user_id).then(pre.presentUser)
  ctx.assert(user, 404);

  // Ensure user owns this trophy
  const trophy = await db.findTrophyByIdAndUserId(ctx.vals.trophy_id, user.id);
  ctx.assert(trophy, 404);

  // Update user's active_trophy_id
  await db.updateUserActiveTrophyId(user.id, trophy.id);

  // Return user to profile
  ctx.flash = { message: ['success', 'Trophy activated'] };
  ctx.redirect(user.url);
});

router.get('/trophy-groups/:id/edit', async (ctx) => {
  // Load
  var group = await db.findTrophyGroupById(ctx.params.id);
  ctx.assert(group, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TROPHY_GROUP', group);

  await ctx.render('edit_trophy_group', {
    ctx,
    group: group
  });
});

// Show trophies-users bridge record edit form
router.get('/trophies-users/:id/edit', async (ctx) => {
  // Load
  var record = await db.findTrophyUserBridgeById(ctx.params.id);
  ctx.assert(record, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'MANAGE_TROPHY_SYSTEM');

  await ctx.render('edit_trophies_users', {
    ctx,
    record: record
  });
});

// Update trophies-users bridge record
router.put('/trophies-users/:id', async (ctx) => {
  // Load
  var record = await db.findTrophyUserBridgeById(ctx.params.id);
  ctx.assert(record, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'MANAGE_TROPHY_SYSTEM');

  ctx.validateParam('id').toInt();

  ctx.validateBody('message-markup');
  if (ctx.request.body['message-markup']) {
    ctx.validateBody('message-markup')
      .trim()
      .isLength(3, 500, 'Message must be 3-500 chars');
  }

  var message_html;
  if (ctx.vals['message-markup']) {
    message_html = bbcode(ctx.vals['message-markup']);
  }

  await db.updateTrophyUserBridge(
    ctx.vals.id,
    ctx.vals['message-markup'],
    message_html
  );

  ctx.redirect('/trophies/' + record.trophy.id);
});

// Show trophy edit form
router.get('/trophies/:id/edit', async (ctx) => {
  // Load
  var trophy = await db.findTrophyById(ctx.params.id);
  ctx.assert(trophy, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TROPHY', trophy);

  await ctx.render('edit_trophy', {
    ctx,
    trophy: trophy
  });
});

// Update trophy
router.put('/trophies/:id', async (ctx) => {
  // Load
  var trophy = await db.findTrophyById(ctx.params.id);
  ctx.assert(trophy, 404);

  // Authorize
  ctx.assertAuthorized(ctx.currUser, 'UPDATE_TROPHY', trophy);

  ctx.validateParam('id').toInt();

  ctx.validateBody('title')
    .isString('Title required')
    .trim()
    .isLength(3, 50, 'Title must be 3-50 chars');

  ctx.validateBody('description-markup');
  if (ctx.request.body['description-markup']) {
    ctx.validateBody('description-markup')
      .trim()
      .isLength(3, 3000, 'Description must be 3-3000 chars');
  }

  var description_html;
  if (ctx.vals['description-markup']) {
    description_html = bbcode(ctx.vals['description-markup']);
  }

  await db.updateTrophy(
    ctx.vals.id,
    ctx.vals.title,
    ctx.vals['description-markup'],
    description_html
  );

  ctx.redirect('/trophies/' + trophy.id);
});

router.get('/trophy-groups/:id', async (ctx) => {
  var group = await db.findTrophyGroupById(ctx.params.id);

  // Ensure group exists
  ctx.assert(group, 404);

  // Fetch trophies
  var trophies = await db.findTrophiesByGroupId(group.id);

  await ctx.render('show_trophy_group', {
    ctx,
    group: group,
    trophies: trophies
  });
});

router.get('/trophies/:id', async (ctx) => {
  const trophy = await db.findTrophyById(ctx.params.id).then(pre.presentTrophy)

  // Ensure trophy exists
  ctx.assert(trophy, 404);

  // Fetch winners
  const winners = await db.findWinnersForTrophyId(trophy.id);

  await ctx.render('show_trophy', {
    ctx,
    trophy: trophy,
    winners: winners
  });
});

router.get('/refresh-homepage/:anchor_name', async (ctx) => {
  ctx.set('X-Robots-Tag', 'none');
  ctx.status = 301;
  ctx.redirect(util.format('/#%s', ctx.params.anchor_name));
});

router.get('/current-feedback-topic', async (ctx) => {
  // ensure user is logged in and admin
  ctx.assert(ctx.currUser && ctx.currUser.role === 'admin', 403);
  // ensure a feedback topic is set
  if (!config.CURRENT_FEEDBACK_TOPIC_ID) {
    ctx.body = 'CURRENT_FEEDBACK_TOPIC_ID is not set';
    return;
  }

  // Load ftopic
  var ftopic = await db.findFeedbackTopicById(config.CURRENT_FEEDBACK_TOPIC_ID);
  ctx.assert(ftopic, 404);
  var replies = await db.findFeedbackRepliesByTopicId(config.CURRENT_FEEDBACK_TOPIC_ID);

  await ctx.render('show_feedback_topic', {
    ctx,
    ftopic,
    replies
  });

});

// text: String
router.post('/current-feedback-topic/replies', async (ctx) => {
  // user must be logged in
  ctx.assert(ctx.currUser, 403);
  // user must not be banned
  ctx.assert(ctx.currUser.banned !== 'banned', 403);
  // ensure a feedback topic is set
  ctx.assert(config.CURRENT_FEEDBACK_TOPIC_ID, 404);
  // ensure user hasn't already acked the ftopic
  var ftopic = await db.findUnackedFeedbackTopic(config.CURRENT_FEEDBACK_TOPIC_ID, ctx.currUser.id);
  ctx.assert(ftopic, 404);

  // Validate form
  ctx.validateBody('commit').isIn(['send', 'ignore']);
  if (ctx.vals.commit === 'send') {
    ctx.validateBody('text')
      .trim()
      .isLength(0, 3000, 'Message may be up to 3000 chars');
  }

  await db.insertReplyToUnackedFeedbackTopic(ftopic.id, ctx.currUser.id, ctx.vals.text, ctx.vals.commit === 'ignore');

  ctx.flash = { message: ['success', 'Thanks for the feedback <3'] };
  ctx.redirect('/');
});

router.get('/chat', async (ctx) => {
  await ctx.render('chat', {
    ctx,
    session_id: ctx.state.session_id,
    chat_server_url: config.CHAT_SERVER_URL,
    //
    title: 'Chat'
  });
});

////////////////////////////////////////////////////////////
// Friendships
// - to_user_id Int
// - commit: Required 'add' | 'remove'
//
// Optionally pass a redirect-to (URI encoded)
router.post('/me/friendships', async (ctx) => {
  // ensure user logged in
  ctx.assert(ctx.currUser, 404);
  ctx.assert(ctx.currUser.role !== 'banned', 404);

  // validate body
  ctx.validateBody('commit').isIn(['add', 'remove']);
  ctx.validateBody('to_user_id').toInt();

  const nodeUrl = require('url');

  let redirectTo;
  if (ctx.query['redirect-to']) {
    const parsed = nodeUrl.parse(decodeURIComponent(ctx.query['redirect-to']));
    redirectTo = parsed.pathname;
  }

  // update db
  if (ctx.vals.commit === 'add') {
    await db.createFriendship(ctx.currUser.id, ctx.vals.to_user_id);
    ctx.flash = { message: ['success', 'Friendship added'] };
  } else {
    await db.deleteFriendship(ctx.currUser.id, ctx.vals.to_user_id);
    ctx.flash = { message: ['success', 'Friendship removed'] };
  }

  // redirect
  ctx.redirect(redirectTo || '/users/' + ctx.vals.to_user_id);
});

router.get('/me/friendships', async (ctx) => {
  // ensure user logged in
  ctx.assert(ctx.currUser, 404);
  ctx.assert(ctx.currUser.role !== 'banned', 404);

  // load friendships
  const friendships = await db.findFriendshipsForUserId(ctx.currUser.id)
    .then((xs) => xs.map(pre.presentFriendship))

  // render
  await ctx.render('me_friendships', {
    ctx,
    friendships,
    title: 'My Friendships'
  });
});

////////////////////////////////////////////////////////////


////////////////////////////////////////////////////////////
// current_sidebar_contests

// Show the current-sidebar-contest form which is what's displayed
// on the Current Contest sidebar panel
router.get('/current-sidebar-contest', async (ctx) => {
  // Ensure user is an admin or conmod
  ctx.assert(ctx.currUser && ['admin', 'conmod'].includes(ctx.currUser.role), 404);

  var currentContest = await db.getCurrentSidebarContest();

  await ctx.render('current_sidebar_contest_show', {
    ctx,
    currentContest: currentContest
  });
});

// Show create form
router.get('/current-sidebar-contest/new', async (ctx) => {
  // Ensure user is an admin or conmod
  ctx.assert(ctx.currUser && ['admin', 'conmod'].includes(ctx.currUser.role), 404);

  await ctx.render('current_sidebar_contest_new', { ctx });
});

// Show edit form
router.get('/current-sidebar-contest/edit', async (ctx) => {
  // Ensure user is an admin or conmod
  ctx.assert(ctx.currUser && ['admin', 'conmod'].includes(ctx.currUser.role), 404);

  var currentContest = await db.getCurrentSidebarContest();

  // Can only go to /edit if there's actually a contest to edit
  if (!currentContest) {
    ctx.flash = { message: ['danger', 'There is no current contest to edit. Did you want to create a new one?'] };
    ctx.redirect('/current-sidebar-contest');
    return;
  }

  await ctx.render('current_sidebar_contest_edit', {
    ctx,
    currentContest: currentContest
  });
});

// Update current contest
//
// Keep in sync with the POST (creation) route
router.put('/current-sidebar-contest', async (ctx) => {
  // Ensure user is an admin or conmod
  ctx.assert(ctx.currUser && ['admin', 'conmod'].includes(ctx.currUser.role), 404);

  // Validation

  ctx.validateBody('title').isString().trim()
  ctx.validateBody('topic_url').isString().tap(s => s.trim());
  ctx.validateBody('deadline').isString().tap(s => s.trim());
  ctx.validateBody('image_url').tap(url => url || undefined);

  // Ensure there is a current contest to update

  var currentContest = await db.getCurrentSidebarContest();

  // Can only update if there's actually a contest to edit
  if (!currentContest) {
    ctx.flash = { message: ['danger', 'There is no current contest to update. If you encounter this message, can you tell Mahz what you did to get here? Because you should not see this message under normal circumstances.'] };
    ctx.redirect('/current-sidebar-contest');
    return;
  }

  // Save the changes to the current contest

  await db.updateCurrentSidebarContest(currentContest.id, {
    title:     ctx.vals.title,
    topic_url: ctx.vals.topic_url,
    deadline:  ctx.vals.deadline,
    image_url: ctx.vals.image_url
  });

  ctx.flash = { message: ['success', 'Contest updated'] };
  ctx.redirect('/current-sidebar-contest');
});

// Create new sidebar contest
router.post('/current-sidebar-contest', async (ctx) => {
  // Ensure user is an admin or conmod
  ctx.assert(ctx.currUser && ['admin', 'conmod'].includes(ctx.currUser.role), 404);

  // Validation

  ctx.validateBody('title').isString().tap(s => s.trim());
  ctx.validateBody('topic_url').isString().tap(s => s.trim());
  ctx.validateBody('deadline').isString().tap(s => s.trim());
  ctx.validateBody('image_url').tap(url => url || undefined);

  var currentContest = await db.insertCurrentSidebarContest({
    title:     ctx.vals.title,
    topic_url: ctx.vals.topic_url,
    deadline:  ctx.vals.deadline,
    image_url: ctx.vals.image_url
  });

  ctx.flash = { message: ['success', 'Current contest created'] };
  ctx.redirect('/current-sidebar-contest');
});

router.del('/current-sidebar-contest', async (ctx) => {
  // Ensure user is an admin or conmod
  ctx.assert(ctx.currUser && ['admin', 'conmod'].includes(ctx.currUser.role), 404);

  await db.clearCurrentSidebarContest();

  ctx.flash = { message: ['success', 'Current contest cleared'] };
  ctx.redirect('/current-sidebar-contest');
});

router.get('/arena-fighters', async (ctx) => {
  const fighters = await db.getArenaLeaderboard();

  await ctx.render('arena_fighters', {
    ctx,
    fighters
  });
});

////////////////////////////////////////////////////////////

app.use(router.routes())

app.listen(config.PORT, function() {
  console.log('Listening on', config.PORT);
});
