
// 3rd
const Router = require('koa-router')
const compress = require('koa-compress')
const nunjucks = require('nunjucks')
// 1st
const cache = require('../cache')

const router = new Router()

////////////////////////////////////////////////////////////

router.use(compress())

////////////////////////////////////////////////////////////

router.get('/sitemap.txt', compress(), async (ctx) => {
  ctx.redirect('/sitemap.xml')
});

router.get('/sitemaps/:idx.txt', async (ctx) => {
  const idx = parseInt(ctx.params.idx) || 0
  const chunk = cache.get('sitemaps')[idx]
  ctx.assert(chunk, 404)
  ctx.type = 'text/plain'
  ctx.body = chunk.join('\n')
})

////////////////////////////////////////////////////////////

// { count: <sitemaps total> }
const indexTemplate = nunjucks.compile(`
<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  {% for i in range(0, count) %}
    <sitemap>
      <loc>https://www.roleplayerguild.com/sitemaps/{{ i }}.txt</loc>
    </sitemap>
  {% endfor %}
</sitemapindex>
`.trim())

router.get('/sitemap.xml', async (ctx) => {
  var chunks = cache.get('sitemaps')
  ctx.type = 'text/xml'
  ctx.body = indexTemplate.render({ count: chunks.length })
})

////////////////////////////////////////////////////////////

module.exports = router
