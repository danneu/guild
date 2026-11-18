-- Read-only numbers for setting the signup network cap in server/config.ts
-- (SIGNUP_NETWORK_LIMIT and SIGNUP_NETWORK_WINDOW_SECONDS). Run it against
-- production with the window you are weighing, in seconds:
--
--   psql "$DATABASE_URL" -v window_seconds=86400 -f scripts/signup-network-calibration.sql
--
-- For each signup it counts what the cap would have seen: the signups from
-- the same network (sql/1-schema.sql#ip_root) in the trailing window that
-- ends at it, itself included. That is a rolling window, as the cap enforces,
-- not a calendar day, which would split a burst across midnight. The cap
-- admits a signup when this count is at most the limit. So a limit at or above
-- the largest count among accounts that were not nuked would have refused no
-- real member. Counts the cap would have refused overstate a little: a
-- refused signup makes no row, so it would not count against the ones after
-- it.
--
-- Only accounts with a registration_ip count, which is those made since
-- sql/8-user-registration-ip.sql. RANGE ... PRECEDING includes a signup exactly
-- one window back, which the cap does not; that differs only on a tie to the
-- microsecond.

BEGIN TRANSACTION READ ONLY;

-- 1. The largest and the high percentiles of the count, for accounts that were
-- nuked and for those that were not.
WITH seen AS (
  SELECT
    is_nuked,
    count(*) OVER (
      PARTITION BY ip_root(registration_ip)
      ORDER BY created_at
      RANGE BETWEEN make_interval(secs => :window_seconds) PRECEDING
        AND CURRENT ROW
    ) AS in_window
  FROM users
  WHERE registration_ip IS NOT NULL
)
SELECT
  is_nuked,
  count(*) AS signups,
  max(in_window) AS max_in_window,
  percentile_disc(0.99) WITHIN GROUP (ORDER BY in_window) AS p99,
  percentile_disc(0.999) WITHIN GROUP (ORDER BY in_window) AS p999
FROM seen
GROUP BY is_nuked
ORDER BY is_nuked;

-- 2. For each limit from 1 to 30, how many signups it would have refused,
-- split by nuked.
WITH seen AS (
  SELECT
    is_nuked,
    count(*) OVER (
      PARTITION BY ip_root(registration_ip)
      ORDER BY created_at
      RANGE BETWEEN make_interval(secs => :window_seconds) PRECEDING
        AND CURRENT ROW
    ) AS in_window
  FROM users
  WHERE registration_ip IS NOT NULL
)
SELECT
  l AS limit_value,
  count(*) FILTER (WHERE NOT is_nuked AND in_window > l) AS real_refused,
  count(*) FILTER (WHERE is_nuked AND in_window > l) AS nuked_refused
FROM seen
CROSS JOIN generate_series(1, 30) AS l
GROUP BY l
ORDER BY l;

-- 3. The 20 networks with the busiest window of real signups, with how many
-- of their accounts were nuked. Check these against
-- server/cloudflare_ip.ts#classifyIp for shared egress such as Private Relay
-- or WARP.
WITH seen AS (
  SELECT
    is_nuked,
    ip_root(registration_ip) AS network,
    count(*) OVER (
      PARTITION BY ip_root(registration_ip)
      ORDER BY created_at
      RANGE BETWEEN make_interval(secs => :window_seconds) PRECEDING
        AND CURRENT ROW
    ) AS in_window
  FROM users
  WHERE registration_ip IS NOT NULL
)
SELECT
  network,
  max(in_window) FILTER (WHERE NOT is_nuked) AS real_peak,
  count(*) FILTER (WHERE NOT is_nuked) AS real_signups,
  count(*) FILTER (WHERE is_nuked) AS nuked_signups
FROM seen
GROUP BY network
ORDER BY real_peak DESC NULLS LAST
LIMIT 20;

ROLLBACK;
