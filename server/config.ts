import "dotenv/config";
import assert from "assert";

export const PORT = parseInt(process.env.PORT || "3000", 10);
// Format: postgres://<user>:<pass>@<host>:<port>/<dbname>
export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://localhost:5432/guild";
// 'development' | 'production'
export const NODE_ENV = process.env.NODE_ENV || "development";

// aws-sdk listens for these env vars
// TODO: Remove my own aws env vars (AWS_SECRET, AWS_KEY) and use these
export const AWS_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
export const AWS_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;

// Various configurable forum settings
export const MIN_TOPIC_TITLE_LENGTH = parseInt(
  process.env.MIN_TOPIC_TITLE_LENGTH || "3",
  10,
);
export const MAX_TOPIC_TITLE_LENGTH = parseInt(
  process.env.MAX_TOPIC_TITLE_LENGTH || "150",
  10,
);
export const MIN_POST_LENGTH = parseInt(process.env.MIN_POST_LENGTH || "1", 10);
export const MAX_POST_LENGTH = parseInt(
  process.env.MAX_POST_LENGTH || "150000",
  10,
);
export const MIN_UNAME_LENGTH = parseInt(
  process.env.MIN_UNAME_LENGTH || "2",
  10,
);
export const MAX_UNAME_LENGTH = parseInt(
  process.env.MAX_UNAME_LENGTH || "15",
  10,
);
export const MAX_BIO_LENGTH = parseInt(
  process.env.MAX_BIO_LENGTH || "100000",
  10,
);
export const MAX_VM_LENGTH = parseInt(process.env.MAX_VM_LENGTH || "300", 10);

// Bounds on markup work, enforced by server/markup.ts. One render or mention
// scan that runs past MARKUP_BUDGET_MS is cut off and refused, and its user's
// markup work is then refused for MARKUP_COOLDOWN_MS. Tune them from
// production render times.
export const MARKUP_BUDGET_MS = parseInt(
  process.env.MARKUP_BUDGET_MS || "1000",
  10,
);
export const MARKUP_COOLDOWN_MS = parseInt(
  process.env.MARKUP_COOLDOWN_MS || "300000",
  10,
);

export const LATEST_RPGN_TOPIC_ID =
  parseInt(process.env.LATEST_RPGN_TOPIC_ID || "fail") || undefined;
export const LATEST_RPGN_IMAGE_URL =
  process.env.LATEST_RPGN_IMAGE_URL || undefined;

export const CURRENT_FEEDBACK_TOPIC_ID =
  parseInt(process.env.CURRENT_FEEDBACK_TOPIC_ID || "fail", 10) || undefined;

// These are limits on the number of notifications a user can generate from a
// single post. If the limit of MENTIONS_PER_POST is 10 and a user mentions 15
// people, then only the first 10 will trigger notifications.
export const MENTIONS_PER_POST = parseInt(
  process.env.MENTIONS_PER_POST || "10",
  10,
);
export const QUOTES_PER_POST = parseInt(
  process.env.QUOTES_PER_POST || "10",
  10,
);

// Determines the link in password reset token email
export const HOST = process.env.HOST || "http://localhost:" + PORT;
// Required for sending emails
export const AWS_KEY = process.env.AWS_KEY;
export const AWS_SECRET = process.env.AWS_SECRET;
export const S3_AVATAR_BUCKET = process.env.S3_AVATAR_BUCKET;
export const S3_IMAGE_BUCKET = process.env.S3_IMAGE_BUCKET;
if (!S3_AVATAR_BUCKET) {
  console.warn("S3_AVATAR_BUCKET not set. Cannot process avatars.");
}
if (!S3_IMAGE_BUCKET) {
  console.warn("S3_IMAGE_BUCKET not set. Cannot process image uploads.");
}
// The folder this deployment's objects sit under in each bucket.
// server/storage.ts builds every key it writes or deletes from these, so a
// deployment that shares a bucket with production cannot touch production's
// objects unless it sets production's folders. The defaults are the
// development folders; fly.toml sets production's.
export const S3_IMAGE_PREFIX = process.env.S3_IMAGE_PREFIX || "dev";
export const S3_AVATAR_PREFIX = process.env.S3_AVATAR_PREFIX || "development";
for (const prefix of [S3_IMAGE_PREFIX, S3_AVATAR_PREFIX]) {
  assert(
    /^[a-z0-9-]+$/.test(prefix),
    `An S3 key prefix is one folder name of a-z, 0-9 and -, not ${prefix}`,
  );
}

// What one account may keep in album images, checked by
// server/storage.ts#storeImage: live images, the bytes they store, and
// uploads in the trailing hour, deleted ones included. Trust is
// server/trust.ts. A stored image is an AVIF that server/imaging.ts shrinks to
// its album edge, so the byte caps are sized on that output.
export const IMAGE_QUOTA = {
  untrusted: {
    images: parseInt(process.env.IMAGE_QUOTA_UNTRUSTED_IMAGES || "50", 10),
    bytes: parseInt(process.env.IMAGE_QUOTA_UNTRUSTED_BYTES || "50000000", 10),
    perHour: parseInt(process.env.IMAGE_QUOTA_UNTRUSTED_PER_HOUR || "20", 10),
  },
  trusted: {
    images: parseInt(process.env.IMAGE_QUOTA_TRUSTED_IMAGES || "1000", 10),
    bytes: parseInt(process.env.IMAGE_QUOTA_TRUSTED_BYTES || "500000000", 10),
    perHour: parseInt(process.env.IMAGE_QUOTA_TRUSTED_PER_HOUR || "60", 10),
  },
};
for (const [standing, quota] of Object.entries(IMAGE_QUOTA)) {
  for (const [cap, value] of Object.entries(quota)) {
    assert(
      Number.isInteger(value) && value > 0,
      `IMAGE_QUOTA.${standing}.${cap} must be a positive integer`,
    );
  }
}

// How old a post must be before it counts toward a member's standing
// (server/trust.ts). Until then the member is new, however many posts they
// make. server/trust.ts writes it into its SQL text, so it must be an integer.
export const TRUST_MIN_POST_AGE_SECONDS = parseInt(
  process.env.TRUST_MIN_POST_AGE_SECONDS || String(3 * 24 * 60 * 60),
  10,
);
assert(
  Number.isInteger(TRUST_MIN_POST_AGE_SECONDS) &&
    TRUST_MIN_POST_AGE_SECONDS >= 0,
  "TRUST_MIN_POST_AGE_SECONDS must be a non-negative integer",
);

export const MAX_CONVO_PARTICIPANTS = parseInt(
  process.env.MAX_CONVO_PARTICIPANTS || "10",
  10,
);

// How much one account may send per trailing hour, in the cost units
// server/db/send_budget.ts#spend charges. Trust is server/trust.ts.
export const SEND_BUDGET_PER_HOUR_UNTRUSTED = parseInt(
  process.env.SEND_BUDGET_PER_HOUR_UNTRUSTED || "30",
  10,
);
export const SEND_BUDGET_PER_HOUR_TRUSTED = parseInt(
  process.env.SEND_BUDGET_PER_HOUR_TRUSTED || "300",
  10,
);
// A budget below the largest convo would refuse that convo forever.
for (const budget of [
  SEND_BUDGET_PER_HOUR_UNTRUSTED,
  SEND_BUDGET_PER_HOUR_TRUSTED,
]) {
  assert(
    Number.isInteger(budget) && budget >= MAX_CONVO_PARTICIPANTS,
    `Send budgets must be integers of at least MAX_CONVO_PARTICIPANTS (${MAX_CONVO_PARTICIPANTS})`,
  );
}

// How many rows of each kind one account may create per trailing hour,
// checked by server/db/row_budget.ts#admitRow. Trust is server/trust.ts. Each
// kind has its own budget, so a burst of one never blocks another. Size the
// roll budgets far above a busy dice session, so only a loop reaches them.
// PROVISIONAL: the defaults are a guess that no production data has checked
// yet (hunt 261117-0852-055). To tune one, set it in fly.toml's [env] or as a
// Fly secret; a refusal logs "[row_budget] refused" in prod:logs.
export const ROW_BUDGET_PER_HOUR = {
  campaign: {
    untrusted: parseInt(process.env.ROW_BUDGET_CAMPAIGNS_UNTRUSTED || "5", 10),
    trusted: parseInt(process.env.ROW_BUDGET_CAMPAIGNS_TRUSTED || "30", 10),
  },
  roll: {
    untrusted: parseInt(process.env.ROW_BUDGET_ROLLS_UNTRUSTED || "300", 10),
    trusted: parseInt(process.env.ROW_BUDGET_ROLLS_TRUSTED || "1200", 10),
  },
  album: {
    untrusted: parseInt(process.env.ROW_BUDGET_ALBUMS_UNTRUSTED || "10", 10),
    trusted: parseInt(process.env.ROW_BUDGET_ALBUMS_TRUSTED || "60", 10),
  },
};
for (const [kind, budgets] of Object.entries(ROW_BUDGET_PER_HOUR)) {
  for (const [standing, value] of Object.entries(budgets)) {
    assert(
      Number.isInteger(value) && value > 0,
      `ROW_BUDGET_PER_HOUR.${kind}.${standing} must be a positive integer`,
    );
  }
}

// The screening budget: what one account may spend on spam classifier calls,
// in the units server/db/screen_budget.ts#spendScreening prices from each
// call's payload. The hour and day budgets bound what one account sends; the
// day budget keeps it far below the API's monthly spend cap. The minute limit
// counts calls, not units, so one account's burst stays far below the API's
// per-minute request limit and its burst rule. Trust is server/trust.ts:
// trusted members are not screened and pay nothing. screen_budget.ts asserts
// that each unit budget fits the largest payload a write can send.
export const SCREEN_BUDGET_PER_HOUR = parseInt(
  process.env.SCREEN_BUDGET_PER_HOUR || "1000",
  10,
);
export const SCREEN_BUDGET_PER_DAY = parseInt(
  process.env.SCREEN_BUDGET_PER_DAY || "2000",
  10,
);
export const SCREEN_CALLS_PER_MINUTE = parseInt(
  process.env.SCREEN_CALLS_PER_MINUTE || "3",
  10,
);

// The signup network cap, checked by
// server/db/accounts.ts#createUserWithSession: one network may open
// SIGNUP_NETWORK_LIMIT accounts in any trailing SIGNUP_NETWORK_WINDOW_SECONDS.
// Set them from production with scripts/signup-network-calibration.sql, so
// the limit sits above the busiest network of real members.
// PROVISIONAL: the defaults are a guess that no production data has checked
// yet (hunt 261117-0852-006). To tune them, set both in fly.toml's [env] or
// as Fly secrets; a refusal logs "[signup] refused network" in prod:logs.
export const SIGNUP_NETWORK_LIMIT = parseInt(
  process.env.SIGNUP_NETWORK_LIMIT || "10",
  10,
);
export const SIGNUP_NETWORK_WINDOW_SECONDS = parseInt(
  process.env.SIGNUP_NETWORK_WINDOW_SECONDS || "86400",
  10,
);
for (const [name, value] of Object.entries({
  SIGNUP_NETWORK_LIMIT,
  SIGNUP_NETWORK_WINDOW_SECONDS,
})) {
  assert(
    Number.isInteger(value) && value > 0,
    `${name} must be a positive integer`,
  );
}

// How many member relays of one kind may reach Discord per trailing hour, such
// as #general welcomes for Introduce Yourself topics. Relays past it are held
// (server/db/member_relays.ts#claimRelay). Size it above the busiest real
// hour, so only a flood of new accounts reaches it.
// PROVISIONAL: the default is a guess that no production data has checked yet
// (hunt 261117-0852-012). To tune it, set it in fly.toml's [env] or as a Fly
// secret; a held relay logs "[discord] held the" in prod:logs.
export const MEMBER_RELAY_CEILING_PER_HOUR = parseInt(
  process.env.MEMBER_RELAY_CEILING_PER_HOUR || "20",
  10,
);
assert(
  Number.isInteger(MEMBER_RELAY_CEILING_PER_HOUR) &&
    MEMBER_RELAY_CEILING_PER_HOUR > 0,
  "MEMBER_RELAY_CEILING_PER_HOUR must be a positive integer",
);

// The max amount of co-GMs per topic
export const MAX_CO_GM_COUNT = process.env.MAX_CO_GM_COUNT || 2;

// How many posts/PMs to display per page in topics/convos
export const POSTS_PER_PAGE = parseInt(process.env.POSTS_PER_PAGE || "20", 10);
// How many users to display per page in user search
export const USERS_PER_PAGE = parseInt(process.env.USERS_PER_PAGE || "20", 10);
// How many recent posts to display on user profile
export const RECENT_POSTS_PER_PAGE = parseInt(
  process.env.RECENT_POSTS_PER_PAGE || "5",
  10,
);
export const CONVOS_PER_PAGE = parseInt(
  process.env.CONVOS_PER_PAGE || "10",
  10,
);

export const FAQ_POST_ID =
  parseInt(process.env.FAQ_POST_ID || "fail", 10) || undefined;
export const WELCOME_POST_ID =
  parseInt(process.env.WELCOME_POST_ID || "fail", 10) || undefined;

// Used as the sender of the welcome PM
// On the Guild, this is set to a user named "Guild Mods" that the mods
// can log into. You will want to periodically check this account to follow
// up with users that respond to the welcome PM
export const STAFF_REPRESENTATIVE_ID = parseInt(
  process.env.STAFF_REPRESENTATIVE_ID || "fail",
  10,
);

// For /search endpoint
export const SEARCH_RESULTS_PER_PAGE = parseInt(
  process.env.SEARCH_RESULTS_PER_PAGE || "50",
  10,
);

// Users to hide from reverse-lookup
export const CLOAKED_SLUGS = (process.env.CLOAKED_SLUGS || "")
  .split(",")
  .filter(Boolean);

export const ENABLE_ADS = !!process.env.ENABLE_ADS;

// 512-bit (64byte) secret used to generate email verification token
// Unused since plan/2026-08-11-1613 replaced the deterministic
// HMAC-SHA512(SECRET, email) verification link with single-use uuid tokens.
// Left in place so an existing deploy's env var is not suddenly rejected.
export const SECRET = process.env.SECRET;

// newrelic
export const NEW_RELIC_LICENSE_KEY = process.env.NEW_RELIC_LICENSE_KEY;
export const NEW_RELIC_APP_NAME =
  process.env.NEW_RELIC_APP_NAME || "localhost-guild";

// anthropic (Claude first-post spam classifier)
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Fixed, so the Anthropic SDK never takes a host from ANTHROPIC_BASE_URL
export const ANTHROPIC_API_URL = "https://api.anthropic.com";
export const IS_ANTISPAM_CONFIGURED = !!ANTHROPIC_API_KEY;
console.log("Antispam (Claude) configured:", IS_ANTISPAM_CONFIGURED);

// /rules redirect and sidebar link
export const RULES_POST_ID =
  Number.parseInt(process.env.RULES_POST_ID || "fail", 10) || null;

// Only surface registration IPs for users who registered on/after this date.
export const REGISTRATION_IP_MILESTONE = new Date("2026-07-04T00:00:00Z");

// Discord / OAuth
export const DISCORD_APP_CLIENTID = process.env.DISCORD_APP_CLIENTID;
export const DISCORD_APP_CLIENTSECRET = process.env.DISCORD_APP_CLIENTSECRET;
export const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
export const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
export const IS_DISCORD_CONFIGURED = !!(
  DISCORD_APP_CLIENTID &&
  DISCORD_APP_CLIENTSECRET &&
  DISCORD_GUILD_ID &&
  DISCORD_BOT_TOKEN
);
console.log("Discord configured:", IS_DISCORD_CONFIGURED);

// Subsystem checks

export const IS_PM_SYSTEM_ONLINE = process.env.IS_PM_SYSTEM_ONLINE === "true";
console.log("PM system online:", IS_PM_SYSTEM_ONLINE);

// Reject requests that bypass Cloudflare and hit the Fly origin directly
// (rpguild.fly.dev). Prod fly.toml only -- staging is direct-access by design.
export const REJECT_ORIGIN_BYPASS = process.env.REJECT_ORIGIN_BYPASS === "true";
console.log("Reject origin bypass:", REJECT_ORIGIN_BYPASS);

export const IS_EMAIL_CONFIGURED = !!(HOST && AWS_KEY && AWS_SECRET);
console.log("Email is configured:", IS_EMAIL_CONFIGURED);

// CLOUDFLARE TURNSTILE
export const CF_TURNSTILE_SITEKEY = process.env.CF_TURNSTILE_SITEKEY;
export const CF_TURNSTILE_SECRET = process.env.CF_TURNSTILE_SECRET;
export const IS_CF_TURNSTILE_CONFIGURED = !!(
  CF_TURNSTILE_SITEKEY && CF_TURNSTILE_SECRET
);
console.log("Turnstile is configured:", IS_CF_TURNSTILE_CONFIGURED);
