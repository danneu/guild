// The only writer of JSON response bodies. Each view below lists the fields
// one client reads, so a column added to a table stays out of every response
// until someone names it here. Two checks hold the rule:
// server/middleware/response-edge.ts answers 500 for any body Koa would
// JSON-encode that sendJson did not build, and server/api_json.test.ts fails
// on a handler that stringifies a body or sets a JSON type itself.
//
// Neither check sees a JSON.stringify held in a variable or built in a helper
// and then sent as an untyped string, or a JSON type set through ctx.set or a
// variable. Don't write those; add a view here instead.

import { Stream } from "node:stream";
import { Context } from "koa";

import * as cancan from "./cancan";
import { classifyIp } from "./cloudflare_ip";
import { DbUser } from "./dbtypes";

type Viewer = DbUser | null | undefined;

// An error body that a client branches on by its code.
export type ApiError =
  | { error: "TOO_SOON" }
  | { error: "SEND_FAILED"; message: string };

// Each view builds a fresh object from its input and returns null only when
// there is nothing to send. The comment names the client that reads it.
const views = {
  // The bio editor in views/show_user.html
  bio: (user: { id: number; bio_markup: string; bio_html: string }) => ({
    id: user.id,
    bio_markup: user.bio_markup,
    bio_html: user.bio_html,
  }),
  // The post editor in views/show_topic.html
  postEdit: (post: { id: number; html: string }) => ({
    id: post.id,
    html: post.html,
  }),
  // The PM editor in views/show_convo.html
  pmEdit: (pm: { id: number; html: string }) => ({ id: pm.id, html: pm.html }),
  // The rating buttons in views/show_topic.html. db.ratePost returns no row
  // for a duplicate rating.
  rating: (rating: { post_id: number; type: string } | null | undefined) =>
    rating ? { post_id: rating.post_id, type: rating.type } : null,
  // The uname typeaheads in views/edit_topic.html and views/search_results.html
  unames: (unames: Iterable<string>) => Array.from(unames),
  // The TOO_SOON alerts in views/show_topic.html and views/homepage.html, and
  // the resend script in views/macros/verify_email.html
  error: (e: ApiError) =>
    e.error === "SEND_FAILED"
      ? { error: e.error, message: e.message }
      : { error: e.error },
  // GET /api/users/:userIdOrSlug, the staff user lookup. The registration IP
  // follows cancan's visibleRegistrationIp for the viewer.
  staffUser: (user: DbUser, viewer: Viewer) => {
    const registrationIp = cancan.visibleRegistrationIp(viewer, user);
    return {
      id: user.id,
      uname: user.uname,
      slug: user.slug,
      role: user.role,
      url: "/users/" + user.slug,
      created_at: user.created_at,
      last_online_at: user.last_online_at,
      avatar_url: user.avatar_url,
      custom_title: user.custom_title,
      posts_count: user.posts_count,
      is_nuked: user.is_nuked,
      // Category is derived from the already-gated registrationIp, so it can
      // never leak when the IP is hidden. It is a machine-readable code; the
      // human-readable label lives in the HTML view.
      registration_ip: registrationIp,
      registration_ip_category: classifyIp(registrationIp),
    };
  },
};

type Views = typeof views;
export type JsonView = keyof Views;

// The bodies sendJson built. The response edge lets an object body through
// only if it is in here.
const ownerBodies = new WeakSet<object>();

// Sets the response body to the named view of input. A view takes the viewer
// from ctx.currUser, so a caller cannot pass another one.
export function sendJson<V extends JsonView>(
  ctx: Context,
  view: V,
  input: Parameters<Views[V]>[0],
): void {
  const build = views[view] as (
    input: unknown,
    viewer: Viewer,
  ) => object | null;
  const body = build(input, ctx.currUser);
  if (body === null) {
    // Koa sends a null body under a JSON type as the string "null".
    ctx.type = "json";
    ctx.body = null;
    return;
  }
  ownerBodies.add(body);
  ctx.body = body;
}

// Throws for a final body that Koa would JSON-encode unless sendJson built it.
// It lets through only kinds that koa 3's lib/application.js#respond sends
// without encoding: none, strings, Buffers, streams by Koa's own test, web
// ReadableStreams, Blobs and fetch Responses. Every other value reaches
// respond's JSON.stringify.
export function assertJsonFromOwner(ctx: Context): void {
  const body: unknown = ctx.body;
  if (body === null || body === undefined) return;
  if (typeof body === "string" || Buffer.isBuffer(body)) return;
  if (
    typeof body === "object" &&
    (isKoaStream(body) ||
      body instanceof ReadableStream ||
      body instanceof Blob ||
      body instanceof Response ||
      ownerBodies.has(body))
  ) {
    return;
  }
  throw new Error(
    `${ctx.method} ${ctx.path} set a ${kindOf(body)} body that sendJson did ` +
      "not build. Send JSON through server/api_json.ts#sendJson.",
  );
}

// Copied from koa 3.0.0 lib/is-stream.js, the test by which Koa's body setter
// and respond pipe a body instead of encoding it. It also accepts objects that
// only look like a readable stream.
function isKoaStream(value: object): boolean {
  if (value instanceof Stream) return true;
  const s = value as Record<string, unknown>;
  return (
    !!s.readable &&
    typeof s.pipe === "function" &&
    typeof s.read === "function" &&
    typeof s.readable === "boolean" &&
    typeof s.readableObjectMode === "boolean" &&
    typeof s.destroy === "function" &&
    typeof s.destroyed === "boolean"
  );
}

function kindOf(value: unknown): string {
  if (typeof value !== "object" && typeof value !== "function") {
    return typeof value;
  }
  return Object.getPrototypeOf(value)?.constructor?.name || "null-prototype";
}
