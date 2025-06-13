// 3rd
import Router from "@koa/router";
import compress from "koa-compress";
import nunjucks from "nunjucks";
// 1st
import cache from "../cache";
import { Context } from "koa";

const router = new Router();

////////////////////////////////////////////////////////////

router.get("/sitemap.txt", async (ctx: Context) => {
  ctx.redirect("/sitemap.xml");
});

router.get("/sitemaps/:idx.txt", compress(), async (ctx: Context) => {
  const idx = parseInt(ctx.params.idx) || 0;
  const chunk = cache.get("sitemaps")[idx];
  ctx.assert(chunk, 404);
  ctx.type = "text/plain";
  ctx.body = chunk.join("\n");
});

////////////////////////////////////////////////////////////

// { count: <sitemaps total> }
const indexTemplate = nunjucks.compile(
  `
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  {% for i in range(0, count) %}
    <sitemap>
      <loc>https://www.roleplayerguild.com/sitemaps/{{ i }}.txt</loc>
    </sitemap>
  {% endfor %}
</sitemapindex>
`.trim(),
);

router.get("/sitemap.xml", async (ctx: Context) => {
  var chunks = cache.get("sitemaps");
  ctx.type = "text/xml";
  ctx.body = indexTemplate.render({ count: chunks.length });
});

////////////////////////////////////////////////////////////

export default router;
