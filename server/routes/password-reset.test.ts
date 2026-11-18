import http from "node:http";
import type { AddressInfo } from "node:net";
import Koa, { Context, Next } from "koa";
import bouncer from "koa-bouncer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as db from "../db";
import * as emailer from "../emailer";
import { answerRefusals } from "../middleware/refusals";
import router, { sendResetMail } from "./password-reset";

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  IS_EMAIL_CONFIGURED: true,
}));
vi.mock("../db", () => ({
  issueResetToken: vi.fn(),
  findUserByResetToken: vi.fn(),
  replacePasswordTx: vi.fn(),
}));
vi.mock("../db/util", () => ({
  pool: {},
  withPgPoolTransaction: vi.fn(async (_pool, fn) => fn({})),
}));
vi.mock("../emailer", () => ({ sendResetTokenEmail: vi.fn() }));

const user = { id: 42, uname: "Member", email: "member@example.com" };
const token = "0190e3a0-0000-7000-8000-0000000000bb";

beforeEach(() => {
  vi.clearAllMocks();
});

// Intent: POST /forgot mails a link only for a token issueResetToken
// returned, so one token lifetime sends one mail.
// Why it exists: hunt finding 261117-0852-031. Requests at once for one
// address each mailed a link.
describe("sendResetMail", () => {
  it("mails nothing when no token comes back", async () => {
    vi.mocked(db.issueResetToken).mockResolvedValue(null);

    await expect(sendResetMail(user)).resolves.toBe("ACTIVE");
    expect(emailer.sendResetTokenEmail).not.toHaveBeenCalled();
  });

  it("mails the token that came back", async () => {
    vi.mocked(db.issueResetToken).mockResolvedValue({
      user_id: user.id,
      token,
      created_at: new Date(),
      expired_at: new Date(),
    });

    await expect(sendResetMail(user)).resolves.toBe("SENT");
    expect(emailer.sendResetTokenEmail).toHaveBeenCalledWith(
      user.uname,
      user.email,
      token,
    );
  });
});

// A bare Koa app with the reset routes behind the app's own error handler.
// The flash setter records what was set, since there is no flash middleware.
// fetch sends no Referer, so an answer that goes back by the Referer lands on
// "/".
async function postResetForm(body: object) {
  let flash: unknown;
  const app = new Koa();
  app.silent = true;
  app.use(async (ctx: Context, next: Next) => {
    (ctx.request as any).body = body;
    Object.defineProperty(ctx, "flash", {
      get: () => flash,
      set: (value) => {
        flash = value;
      },
    });
    return next();
  });
  app.use(bouncer.middleware());
  app.use(answerRefusals());
  app.use(router.routes());

  const server = http.createServer(app.callback());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/reset-password`, {
      method: "POST",
      redirect: "manual",
    });
    return { status: res.status, location: res.headers.get("location"), flash };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("POST /reset-password", () => {
  beforeEach(() => {
    vi.mocked(db.findUserByResetToken).mockResolvedValue(user as any);
    vi.mocked(db.replacePasswordTx).mockResolvedValue({ id: "1" } as any);
  });

  // Intent: a reset refuses a password that signup would refuse, writes
  // nothing, and sends the member back to the form with their token, so the
  // token still works.
  // Why it exists: hunt finding 261117-0852-045. The route checked only that
  // the two fields matched. It stored an empty password, and with both fields
  // missing bcrypt threw and the route answered 500.
  // Scenario: a member with a mailed token submits an empty password, or a
  // crafted post leaves both fields out. Then they try again with a good one.
  it.each([
    { name: "an empty password", passwords: { password1: "", password2: "" } },
    { name: "a missing password", passwords: {} },
  ])("refuses $name and keeps the token", async ({ passwords }) => {
    const refused = await postResetForm({ token, ...passwords });

    expect(db.replacePasswordTx).not.toHaveBeenCalled();
    expect(refused.status).toBe(302);
    expect(refused.location).toBe(`/reset-password?token=${token}`);
    expect(refused.flash).toEqual({ message: ["danger", expect.any(String)] });

    const retried = await postResetForm({
      token,
      password1: "secret1",
      password2: "secret1",
    });

    expect(retried.location).toBe("/");
    expect(db.replacePasswordTx).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      expect.any(String),
      expect.anything(),
    );
  });
});
