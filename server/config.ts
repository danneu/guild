export const PORT = parseInt(process.env.PORT || '3000', 10)
// Format: postgres://<user>:<pass>@<host>:<port>/<dbname>
export const DATABASE_URL =
    process.env.DATABASE_URL || 'postgres://localhost:5432/guild'
// 'development' | 'production'
export const NODE_ENV = process.env.NODE_ENV || 'development'

export const RECAPTCHA_SITEKEY = process.env.RECAPTCHA_SITEKEY
export const RECAPTCHA_SITESECRET = process.env.RECAPTCHA_SITESECRET

// aws-sdk listens for these env vars
// TODO: Remove my own aws env vars (AWS_SECRET, AWS_KEY) and use these
export const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY

// Various configurable forum settings
export const MIN_TOPIC_TITLE_LENGTH =
    parseInt(process.env.MIN_TOPIC_TITLE_LENGTH || '3', 10)
export const MAX_TOPIC_TITLE_LENGTH =
    parseInt(process.env.MAX_TOPIC_TITLE_LENGTH || '150', 10)
export const MIN_POST_LENGTH = parseInt(process.env.MIN_POST_LENGTH || '1', 10)
export const MAX_POST_LENGTH = parseInt(process.env.MAX_POST_LENGTH || '150000', 10)
export const MIN_UNAME_LENGTH = parseInt(process.env.MIN_UNAME_LENGTH || '2', 10)
export const MAX_UNAME_LENGTH = parseInt(process.env.MAX_UNAME_LENGTH || '15', 10)
export const MAX_BIO_LENGTH = parseInt(process.env.MAX_BIO_LENGTH || '100000', 10)
export const MAX_VM_LENGTH = parseInt(process.env.MAX_VM_LENGTH || '300', 10)

export const LATEST_RPGN_TOPIC_ID =
    parseInt(process.env.LATEST_RPGN_TOPIC_ID || 'fail') || undefined
export const LATEST_RPGN_IMAGE_URL = process.env.LATEST_RPGN_IMAGE_URL || undefined

export const CURRENT_FEEDBACK_TOPIC_ID =
    parseInt(process.env.CURRENT_FEEDBACK_TOPIC_ID || 'fail', 10) || undefined

// These are limits on the number of notifications a user can generate from a
// single post. If the limit of MENTIONS_PER_POST is 10 and a user mentions 15
// people, then only the first 10 will trigger notifications.
export const MENTIONS_PER_POST = parseInt(process.env.MENTIONS_PER_POST || '10', 10)
export const QUOTES_PER_POST = parseInt(process.env.QUOTES_PER_POST || '10', 10)

// Determines the link in password reset token email
export const HOST = process.env.HOST || 'http://localhost:' + exports.PORT
// Required for sending emails
export const AWS_KEY = process.env.AWS_KEY
export const AWS_SECRET = process.env.AWS_SECRET
export const S3_AVATAR_BUCKET = process.env.S3_AVATAR_BUCKET
export const S3_IMAGE_BUCKET = process.env.S3_IMAGE_BUCKET
if (!S3_AVATAR_BUCKET) {
    console.warn('S3_AVATAR_BUCKET not set. Cannot process avatars.')
}
if (!S3_IMAGE_BUCKET) {
    console.warn('S3_IMAGE_BUCKET not set. Cannot process image uploads.')
}

export const MAX_CONVO_PARTICIPANTS =
    parseInt(process.env.MAX_CONVO_PARTICIPANTS || '10', 10)

// The max amount of co-GMs per topic
export const MAX_CO_GM_COUNT = process.env.MAX_CO_GM_COUNT || 2

// How many posts/PMs to display per page in topics/convos
export const POSTS_PER_PAGE = parseInt(process.env.POSTS_PER_PAGE || '20', 10)
// How many users to display per page in user search
export const USERS_PER_PAGE = parseInt(process.env.USERS_PER_PAGE || '20', 10)
// How many recent posts to display on user profile
export const RECENT_POSTS_PER_PAGE =
    parseInt(process.env.RECENT_POSTS_PER_PAGE || '5', 10)
export const CONVOS_PER_PAGE = parseInt(process.env.CONVOS_PER_PAGE || '10', 10)

export const FAQ_POST_ID = parseInt(process.env.FAQ_POST_ID || 'fail', 10) || undefined
export const WELCOME_POST_ID = parseInt(process.env.WELCOME_POST_ID || 'fail', 10) || undefined

// Used as the sender of the welcome PM
// On the Guild, this is set to a user named "Guild Mods" that the mods
// can log into. You will want to periodically check this account to follow
// up with users that respond to the welcome PM
export const STAFF_REPRESENTATIVE_ID = parseInt(process.env.STAFF_REPRESENTATIVE_ID || 'fail', 10)

// For /search endpoint
export const SEARCH_RESULTS_PER_PAGE =
    parseInt(process.env.SEARCH_RESULTS_PER_PAGE || '50', 10)

// Users to hide from reverse-lookup
export const CLOAKED_SLUGS = (process.env.CLOAKED_SLUGS || '')
    .split(',')
    .filter(Boolean)

export const ENABLE_ADS = !!process.env.ENABLE_ADS

export const CHAT_SERVER_URL = process.env.CHAT_SERVER_URL || 'http://localhost:3001'

// 512-bit (64byte) secret used to generate email verification token
export const SECRET = process.env.SECRET

// newrelic
export const NEW_RELIC_LICENSE_KEY = process.env.NEW_RELIC_LICENSE_KEY
export const NEW_RELIC_APP_NAME = process.env.NEW_RELIC_APP_NAME || 'localhost-guild'

// akismet
export const AKISMET_KEY = process.env.AKISMET_KEY

// /rules redirect and sidebar link
export const RULES_POST_ID = Number.parseInt(process.env.RULES_POST_ID || 'fail', 10) || null

// Discord / OAuth
export const DISCORD_APP_CLIENTID = process.env.DISCORD_APP_CLIENTID
export const DISCORD_APP_CLIENTSECRET = process.env.DISCORD_APP_CLIENTSECRET
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN
export const IS_DISCORD_CONFIGURED = !!(
    DISCORD_APP_CLIENTID &&
    DISCORD_APP_CLIENTSECRET &&
    DISCORD_GUILD_ID &&
    DISCORD_BOT_TOKEN
)
console.log('Discord configured:', IS_DISCORD_CONFIGURED)

// Subsystem checks

export const IS_PM_SYSTEM_ONLINE = process.env.IS_PM_SYSTEM_ONLINE === 'true'
console.log('PM system online:', IS_PM_SYSTEM_ONLINE)

export const IS_EMAIL_CONFIGURED = !!(
    HOST &&
    AWS_KEY &&
    AWS_SECRET
)
console.log('Email is configured:', IS_EMAIL_CONFIGURED)


// CLOUDFLARE TURNSTILE
export const CF_TURNSTILE_SITEKEY = process.env.CF_TURNSTILE_SITEKEY
export const CF_TURNSTILE_SECRET = process.env.CF_TURNSTILE_SECRET
export const IS_CF_TURNSTILE_CONFIGURED = !!(CF_TURNSTILE_SITEKEY && CF_TURNSTILE_SECRET)
console.log('Turnstile is configured:', IS_CF_TURNSTILE_CONFIGURED)

if (NODE_ENV === 'development') {
    console.log('Config vars:')
    console.log(JSON.stringify(process.env, null, '  '))
}
