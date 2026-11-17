// Post-deploy probe of the CSRF gate (server/middleware/protect-csrf.ts)
// through the real proxies.
//
// The gate trusts two things no unit test can see: that Cloudflare and Fly
// pass Sec-Fetch-Site through unchanged, and that the Host reaching Node is
// the one the browser sent. Run this after a production deploy that touches
// the gate, and after any change to Cloudflare or Fly routing. Staging is not
// behind Cloudflare, so only production can answer it.
//
// Each case POSTs to a path no route serves. A write the gate passes answers
// 404, and one it refuses answers 403 with Koa's "Forbidden" body, which tells
// it apart from a Cloudflare block page. Node's fetch sends no Origin or
// Sec-Fetch-Site of its own, so each case sends exactly the headers it lists.
//
// Usage:
//   pnpm exec tsx scripts/csrf-probe.ts [base-url]
//
// base-url defaults to https://www.roleplayerguild.com. Expect 5/5.

const PROBE_PATH = "/csrf-probe";

type Case = {
  name: string;
  headers: Record<string, string>;
  expect: "pass" | "refuse";
  // What a failure most likely means.
  hint: string;
};

function cases(own: string): Case[] {
  return [
    {
      // No Origin, so only a Sec-Fetch-Site that arrived can pass it.
      name: "Sec-Fetch-Site same-origin, no Origin",
      headers: { "sec-fetch-site": "same-origin" },
      expect: "pass",
      hint: "a proxy strips Sec-Fetch-Site",
    },
    {
      // The own Origin, so only a Sec-Fetch-Site that arrived can refuse it.
      name: "Sec-Fetch-Site same-site, own Origin",
      headers: { "sec-fetch-site": "same-site", origin: own },
      expect: "refuse",
      hint: "a proxy strips or rewrites Sec-Fetch-Site",
    },
    {
      name: "Sec-Fetch-Site cross-site, own Origin",
      headers: { "sec-fetch-site": "cross-site", origin: own },
      expect: "refuse",
      hint: "a proxy strips or rewrites Sec-Fetch-Site",
    },
    {
      name: "no Sec-Fetch-Site, own Origin",
      headers: { origin: own },
      expect: "pass",
      hint: "the Host reaching Node is not the one in the URL, so browsers without Sec-Fetch-Site cannot write",
    },
    {
      name: "no Sec-Fetch-Site, no Origin",
      headers: {},
      expect: "refuse",
      hint: "the gate is not mounted, or something answers ahead of it",
    },
  ];
}

async function main() {
  const base = new URL(process.argv[2] ?? "https://www.roleplayerguild.com");
  const all = cases(base.origin);
  let passed = 0;

  for (const c of all) {
    const res = await fetch(new URL(PROBE_PATH, base), {
      method: "POST",
      headers: c.headers,
      redirect: "manual",
    });
    const body = (await res.text()).trim();
    const ok =
      c.expect === "pass"
        ? res.status === 404
        : res.status === 403 && body === "Forbidden";
    if (ok) passed++;

    const want = c.expect === "pass" ? "404" : "403 Forbidden";
    console.log(
      `${ok ? "PASS" : "FAIL"} ${c.name} -- want ${want}, got ${res.status} ${body.slice(0, 80)}`,
    );
    if (!ok) console.log(`     likely: ${c.hint}`);
  }

  console.log(`\n${passed}/${all.length} passed`);
  process.exit(passed === all.length ? 0 : 1);
}

main().catch((err) => {
  console.error("probe crashed:", err);
  process.exit(1);
});
