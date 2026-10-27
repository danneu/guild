import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import Koa from "koa";
import bouncer from "koa-bouncer";
import _ from "lodash";
import nunjucks from "nunjucks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { query } = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../db/util.js", () => ({ pool: { query } }));
vi.mock("../cache3", () => ({
  default: { get: (key: string) => (key === "categories" ? [] : {}) },
}));

import searchRoutes from "./search";

// search_results.html extends the site layout. This stand-in renders only the
// page's embed block, so the test needs only the globals that block uses.
const layoutStub = {
  getSource(name: string) {
    if (name !== "layouts/master.html") return null;
    return {
      src: "{% block embed %}{% endblock %}",
      path: name,
      noCache: true,
    };
  },
};

// Same views root as server/index.ts#nunjucksOptions, with nunjucks' default
// escaping.
const env = new nunjucks.Environment([
  layoutStub as unknown as nunjucks.ILoader,
  new nunjucks.FileSystemLoader(path.join(__dirname, "../../views")),
]);
env.addGlobal("_", _);
env.addGlobal("belt", { mergeQuery: () => "" });
env.addGlobal("ago", () => "");
env.addFilter("json", (x) => JSON.stringify(x));
env.addFilter("isIn", (v, coll) => (coll || []).includes(v));
env.addFilter("formatDate", () => "");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = new Koa();
  app.use(bouncer.middleware());
  app.use(async (ctx, next) => {
    ctx.currUser = { id: 1, uname: "Viewer", slug: "viewer", role: "member" };
    ctx.render = async (name: string, locals: object) => {
      ctx.body = env.render(`${name}.html`, locals);
    };
    await next();
  });
  app.use(searchRoutes.routes());
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

// The route asks cancan about every row (server/readable.ts#fetchReadable),
// so the topic carries the columns READ_POST reads. The attacker's own public
// post passes it.
function postRow(highlight: string) {
  return {
    id: 7,
    type: "ooc",
    markup: "hello dragon, <img src=x onerror=alert(1)> world",
    html: "<p>hello dragon</p>",
    is_hidden: false,
    created_at: "2026-10-26T00:00:00Z",
    rank: 0.1,
    highlight,
    user: { id: 2, uname: "Author", slug: "author" },
    topic: {
      id: 3,
      title: "A topic",
      user_id: 2,
      forum_id: 4,
      co_gm_ids: [],
      is_hidden: false,
    },
    forum: { id: 4, title: "A forum", category_id: 1 },
  };
}

describe("GET /search", () => {
  // Intent: a search headline prints the post's raw markup as text, with the
  // matched words in bold.
  // Why it exists: finding 261026-0911-002. ts_headline runs over the markup
  // the author typed, and the page printed it as live HTML, so a post holding
  // <img src=x onerror=...> ran script for anyone whose search matched it.
  // Scenario: the post's markup carries an img tag with an onerror handler.
  // The row holds what ts_headline returns for it, each match between the
  // U+0001 and U+0002 markers.
  it("escapes author markup in the headline and keeps the bold match", async () => {
    query.mockResolvedValueOnce({
      rows: [
        postRow("hello \u0001dragon\u0002, <img src=x onerror=alert(1)> world"),
      ],
    });

    const res = await fetch(`${baseUrl}/search?term=dragon`);
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(body).toContain("hello <b>dragon</b>, &lt;img");
  });
});
