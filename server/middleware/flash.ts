import { Context, Next } from "koa";

// The form fields a flash echoes back, so the page it redirects to can fill
// its form in again. The flash cookie holds them in plain text, so each
// caller names the fields it echoes, and a field nobody names, such as a
// password, never reaches the cookie.
//
// pick is the only way to make one, and the flash setter drops any other
// params. Request bodies are typed any, so the runtime check is what stops
// a whole body from going in.
export class FlashParams {
  private constructor(readonly fields: Readonly<Record<string, unknown>>) {}

  static pick(source: unknown, names: readonly string[]): FlashParams {
    const fields: Record<string, unknown> = {};
    if (source && typeof source === "object") {
      for (const name of names) {
        if (Object.hasOwn(source, name)) {
          fields[name] = (source as Record<string, unknown>)[name];
        }
      }
    }
    return new FlashParams(fields);
  }
}

// The fields the app-wide error handlers in server/index.ts echo. They catch
// a validation error from any route, so they cannot know its form. This is
// every non-secret field a view fills in from ctx.flash.params.
export const FORM_REFILL_FIELDS: readonly string[] = [
  "uname-or-email",
  "uname",
  "email",
  "to",
  "title",
  "markup",
  "text",
  "join-status",
  "post-type",
  "tag-ids",
  "topic_url",
  "deadline",
  "image_url",
  "description",
];

export type FlashLevel = "success" | "danger" | "warning" | "info";

// What a route sets. A page reads it back from the cookie as plain JSON, so
// the getter gives params as a plain object.
export type Flash = {
  message?: [FlashLevel, string];
  params?: FlashParams;
  // views/login.html shows the Turnstile widget.
  challenge?: boolean;
};

function toCookieJson(val: Flash): string {
  const { params, ...rest } = val;
  if (params === undefined) return JSON.stringify(rest);
  if (!(params instanceof FlashParams)) {
    console.error("flash: dropped params not made by FlashParams.pick");
    return JSON.stringify(rest);
  }
  return JSON.stringify({ ...rest, params: params.fields });
}

// Expose req.flash (getter) and res.flash = _ (setter)
// Flash data persists in user's sessions until the next ~successful response
export function flash(cookieName = "flash") {
  return async (ctx: Context, next: Next) => {
    let data = Object.create(null);

    if (ctx.cookies.get(cookieName)) {
      try {
        data = JSON.parse(
          decodeURIComponent(ctx.cookies.get(cookieName) ?? ""),
        );
      } catch (err) {
        // If cookie had a value but was not JSON, then trash the cookie
        ctx.cookies.set(cookieName, null);
      }
    }

    Object.defineProperty(ctx, "flash", {
      enumerable: true,
      get: () => {
        return data;
      },
      set: (val: Flash) => {
        const encodedVal = encodeURIComponent(toCookieJson(val));
        ctx.cookies.set(cookieName, encodedVal, {
          // Expire flash cookie in 10 seconds to avoid stale cookie
          maxAge: 10 * 1000,
        });
      },
    });

    await next();

    // Clear flash cookie on successful response *and* if the cookie is
    // not already cleared
    if (
      ctx.response.status < 300 &&
      ctx.cookies.get(cookieName) !== undefined
    ) {
      ctx.cookies.set(cookieName, null);
    }
  };
}
