import { beforeEach, describe, expect, it, vi } from "vitest";

import { pool } from "./util.js";
import { getUserAlbum, getUserImage, updateAlbum } from "./images";

// These pin the owner filter in the SQL text and the bound params each write
// sends.
vi.mock("./util.js", () => ({
  pool: { query: vi.fn() },
  maybeOneRow: (res: { rows: unknown[] }) => res.rows[0],
}));

const query = vi.mocked(pool.query) as any;

const ownerId = 7;
const imageId = "0190d5a0-0000-7000-8000-000000000001";
const albumId = 3;

function lastCall(): [string, unknown[] | undefined] {
  const call = query.mock.calls.at(-1);
  return [call[0], call[1]];
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe("getUserImage", () => {
  it("filters on the owner", async () => {
    await getUserImage(ownerId, imageId);

    const [sql, params] = lastCall();
    expect(sql).toMatch(/WHERE images\.id = \$1\s+AND images\.user_id = \$2/);
    expect(params).toEqual([imageId, ownerId]);
  });
});

describe("getUserAlbum", () => {
  it("filters on the owner", async () => {
    await getUserAlbum(ownerId, albumId);

    const [sql, params] = lastCall();
    expect(sql).toMatch(/WHERE a\.id = \$1\s+AND a\.user_id = \$2/);
    expect(params).toEqual([albumId, ownerId]);
  });
});

describe("updateAlbum", () => {
  it("only updates the owner's row", async () => {
    await updateAlbum(ownerId, albumId, { title: "t" });

    const [sql] = lastCall();
    expect(sql).toContain(`"id" = ${albumId}`);
    expect(sql).toContain(`"user_id" = ${ownerId}`);
  });

  it("reports whether a row changed", async () => {
    await expect(updateAlbum(ownerId, albumId, { title: "t" })).resolves.toBe(
      true,
    );

    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(updateAlbum(ownerId, albumId, { title: "t" })).resolves.toBe(
      false,
    );
  });
});
