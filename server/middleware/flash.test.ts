import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context } from "koa";
import { describe, expect, it, vi } from "vitest";

import { flash, FlashParams, FORM_REFILL_FIELDS } from "./flash";

////////////////////////////////////////////////////////////
// Harness
//
// A bare Koa app with the flash middleware and a handler that sets the flash
// it is given, as a failed form post does, then redirects. Returns what the
// flash cookie holds.

async function setFlash(val: unknown): Promise<unknown> {
  const app = new Koa();
  app.silent = true;
  app.use(flash());
  app.use(async (ctx: Context) => {
    ctx.flash = val as any;
    ctx.redirect("/back");
  });

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      redirect: "manual",
    });
    const cookie = res.headers
      .getSetCookie()
      .find((c) => c.startsWith("flash="));
    expect(cookie).toBeDefined();
    const raw = cookie!.slice("flash=".length).split(";")[0];
    return JSON.parse(decodeURIComponent(raw));
  } finally {
    server.close();
  }
}

// A failed login or registration body, as the forms in views/ post it.
const body = {
  "uname-or-email": "foo",
  uname: "foo",
  email: "foo@example.com",
  password: "hunter2",
  password1: "hunter3",
  password2: "hunter3",
  "cf-turnstile-response": "token",
};

describe("flash cookie", () => {
  it("holds only the fields a caller picks", async () => {
    const stored = await setFlash({
      message: ["danger", "Invalid creds (3)"],
      params: FlashParams.pick(body, ["uname", "email", "missing"]),
    });
    expect(stored).toEqual({
      message: ["danger", "Invalid creds (3)"],
      params: { uname: "foo", email: "foo@example.com" },
    });
  });

  it("drops params that are not FlashParams, such as a whole body", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stored = await setFlash({
        message: ["danger", "Validation error"],
        params: body,
      });
      expect(stored).toEqual({ message: ["danger", "Validation error"] });
      expect(error).toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it("keeps a flash without params as it was", async () => {
    const stored = await setFlash({ message: ["success", "Logged in"] });
    expect(stored).toEqual({ message: ["success", "Logged in"] });
  });

  it("refills no secret field from the app-wide error handlers", async () => {
    const stored = (await setFlash({
      message: ["danger", "Validation error"],
      params: FlashParams.pick(body, FORM_REFILL_FIELDS),
    })) as { params: Record<string, unknown> };
    expect(stored.params).toEqual({
      "uname-or-email": "foo",
      uname: "foo",
      email: "foo@example.com",
    });
  });
});
