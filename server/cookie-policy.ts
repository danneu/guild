// The one owner of the security attributes on every cookie the server sets.
// It patches the app once at boot instead of running as middleware, so it has
// no place in the app.use order to get wrong. Cookies that client JS writes
// with document.cookie are outside it.

import type Koa from "koa";
import type { Context } from "koa";

type Jar = Context["cookies"];
type SetOptions = Parameters<Jar["set"]>[2];

/**
 * Makes every ctx.cookies.set on this app send SameSite=Lax and HttpOnly, and
 * Secure exactly when `secure` is true. Secure comes from this flag, not from
 * ctx.secure: behind Fly, TLS ends before Node, so Koa sees every request as
 * http. Lax, not Strict, because the Discord OAuth return and links from email
 * are cross-site top-level GETs that must carry their cookies. The policy is
 * applied after the caller's options, so no call can loosen it.
 */
export function installCookiePolicy(
  app: Koa,
  { secure }: { secure: boolean },
): void {
  // Koa 3 makes each ctx with Object.create(app.context), and its cookies
  // accessor lives on the prototype of app.context. An accessor on app.context
  // shadows it for this app only.
  const koa = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(app.context),
    "cookies",
  );
  const koaGet = koa?.get;
  const koaSet = koa?.set;
  if (!koaGet || !koaSet) {
    throw new Error(
      "installCookiePolicy: Koa's context has no cookies accessor to wrap",
    );
  }

  const policed = new WeakSet<Jar>();
  Object.defineProperty(app.context, "cookies", {
    configurable: true,
    get(this: Context): Jar {
      // Koa's getter caches one jar per request, so each jar is policed once.
      const jar: Jar = koaGet.call(this);
      if (!policed.has(jar)) {
        policed.add(jar);
        police(jar, secure);
      }
      return jar;
    },
    set(this: Context, jar: Jar) {
      koaSet.call(this, jar);
    },
  });
}

function police(jar: Jar, secure: boolean): void {
  // cookies 0.9.1 throws on a Secure cookie when the jar's own flag is false,
  // and Koa set that flag from ctx.secure.
  jar.secure = secure;
  const set = jar.set;
  jar.set = function (name: string, value?: string | null, opts?: SetOptions) {
    // cookies 0.9.1 lets the deprecated secureProxy option overwrite Secure
    // after it reads secure, so drop the key. Setting it would not help: any
    // secureProxy key logs a deprecation on every set.
    const { secureProxy: _dropped, ...rest } = opts ?? {};
    return set.call(this, name, value, {
      ...rest,
      secure,
      sameSite: "lax",
      httpOnly: true,
    });
  };
}
