// 3rd
// import createDebug from 'debug';
// const debug = createDebug('app:db:dice')
import assert from "assert";
// 1st
import type { Rolled } from "../dice";
import { unwrapUserHtml, type UserHtml } from "../user_html";
import { admitRow } from "./row_budget";
import { spendScreening, type ScreeningCharge } from "./screen_budget";
import { lockStanding } from "./send_budget";
import { pool, maybeOneRow, exactlyOneRow } from "./util";

export const getCampaign = async function (campaignId: number) {
  return pool
    .query(
      `
    SELECT
      c.*,
      to_json(u.*) "user"
    FROM campaigns c
    JOIN users u ON c.user_id = u.id
    WHERE c.id = $1
      AND u.is_nuked = false
  `,
      [campaignId],
    )
    .then(maybeOneRow);
};

export const listCampaignsByActivity = async function () {
  return pool
    .query(
      `
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    WHERE users.is_nuked = false
    ORDER BY c.last_roll_id DESC NULLS LAST
    LIMIT 100
  `,
    )
    .then((res) => res.rows);
};

// Ordered by newest first
export const getCampaignsForUser = async function (userId: number) {
  assert(userId);
  return pool
    .query(
      `
    SELECT
      c.*,
      to_json(users.*) "user",
      to_json(r.*) "last_roll"
    FROM campaigns c
    JOIN users ON c.user_id = users.id
    LEFT OUTER JOIN rolls r ON c.last_roll_id = r.id
    WHERE c.user_id = $1
      AND users.is_nuked = false
    ORDER BY c.id DESC
    LIMIT 100
  `,
      [userId],
    )
    .then((res) => res.rows);
};

export const getCampaignRolls = async function (campaignId: number) {
  assert(campaignId);
  return pool
    .query(
      `
    SELECT
      r.*,
      to_json(users.*) "user"
    FROM rolls r
    JOIN users ON r.user_id = users.id
    WHERE r.campaign_id = $1
      AND users.is_nuked = false
    ORDER BY r.id DESC
    LIMIT 100
  `,
      [campaignId],
    )
    .then((res) => res.rows);
};

// Sets a campaign's title and markup. The actor, the campaign's owner or
// staff, pays the screening charge for the new text while new
// (server/db/screen_budget.ts). The charge comes back for the route to hand
// to the classifier after the commit. html is the markup the route rendered.
export async function updateCampaign(
  actorId: number,
  campaignId: number,
  title: string,
  markup: string,
  html: UserHtml,
): Promise<ScreeningCharge | null> {
  assert(Number.isInteger(campaignId));
  assert(typeof title === "string");
  return pool.withTransaction(async (client) => {
    const standing = await lockStanding(client, actorId);
    const charge = await spendScreening(client, standing, {
      title,
      body: markup,
    });
    await client.query(
      `
      UPDATE campaigns
      SET title = $1
        , markup = $2
        , html = $3
      WHERE id = $4
    `,
      [title, markup, unwrapUserHtml(html), campaignId],
    );
    return charge;
  });
}

// Creates a campaign. Its author pays the campaign row budget
// (server/db/row_budget.ts) and, while new, the screening charge for its title
// and markup (server/db/screen_budget.ts), which comes back with the campaign
// for the route to hand to the classifier after the commit. html is the
// markup the route rendered.
export async function insertCampaign(
  userId: number,
  title: string,
  markup: string,
  html: UserHtml,
): Promise<{ campaign: any; charge: ScreeningCharge | null }> {
  assert(Number.isInteger(userId));
  assert(typeof title === "string");
  return pool.withTransaction(async (client) => {
    const standing = await lockStanding(client, userId);
    const now = await admitRow(client, standing, "campaign");
    const charge = await spendScreening(client, standing, {
      title,
      body: markup,
    });
    const campaign = await client
      .query(
        `
        INSERT INTO campaigns (user_id, title, markup, html, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `,
        [userId, title, markup, unwrapUserHtml(html), now],
      )
      .then(exactlyOneRow);
    return { campaign, charge };
  });
}

// Stores a roll that server/dice.ts#roll made, so a roll it refused has
// nothing to store. Its roller pays the roll row budget
// (server/db/row_budget.ts). note is optional.
export const insertRoll = async function (
  userId: number,
  campaignId: number,
  output: Rolled,
  note?: string,
) {
  assert(Number.isInteger(userId));
  assert(Number.isInteger(campaignId));
  return pool.withTransaction(async (client) => {
    const standing = await lockStanding(client, userId);
    const now = await admitRow(client, standing, "roll");
    const roll = await client
      .query(
        `
      INSERT INTO rolls (user_id, campaign_id, syntax, rolls, total, note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `,
        [
          userId,
          campaignId,
          output.syntax,
          JSON.stringify(output.rolls),
          output.total,
          note,
          now,
        ],
      )
      .then(maybeOneRow);

    await client.query(
      `
      UPDATE campaigns
      SET last_roll_at = NOW()
        , roll_count = roll_count + 1
        , last_roll_id = $1
      WHERE id = $2
    `,
      [roll.id, campaignId],
    );

    return roll;
  });
};

export const getRoll = async function (rollId: number) {
  assert(rollId);
  return pool
    .query(
      `
    SELECT
      r.*,
      to_json(u.*) "user",
      to_json(c.*) "campaign"
    FROM rolls r
    JOIN users u ON r.user_id = u.id
    JOIN campaigns c ON r.campaign_id = c.id
    JOIN users cu ON c.user_id = cu.id
    WHERE r.id = $1
      AND u.is_nuked = false
      AND cu.is_nuked = false
  `,
      [rollId],
    )
    .then(maybeOneRow);
};
