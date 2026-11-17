// In-memory stand-ins for what server/storage.ts talks to: the S3 calls of
// server/s3.ts, and the Postgres statements that storage.ts and
// server/db/send_budget.ts#lockStanding send. Test-only. A test mocks
// server/s3.ts with fakeS3 and server/db/util.ts with fakeDbUtil, so the real
// storage code runs against them.
//
// The pg stand-in answers statements by their text and ignores what Postgres
// would do with the rest, so the SQL itself is reviewed, not tested. It throws
// on a statement about images it does not know, so a new one fails loudly.

export type FakeImage = {
  id: string;
  user_id: number;
  album_id: number;
  src: string;
  mime: string;
  description: string | null;
  bytes: number;
  deleted_at: Date | null;
  created_at: Date;
};

export type FakeUser = {
  id: number;
  uname: string;
  approved_at: Date | null;
  posts_count: number;
  avatar_url: string;
  legacy_avatar_url: string | null;
};

export type FakeAlbum = { id: number; user_id: number };

// What happened, in order: each S3 call once S3 has answered, and each images
// or avatar write. Tests read it to check ordering.
export type FakeEvent =
  | { op: "put"; bucket: string; key: string }
  | { op: "delete"; bucket: string; keys: string[] }
  | { op: "insert"; id: string }
  | { op: "hide"; ids: string[] }
  | { op: "unhide"; ids: string[] }
  | { op: "avatar_url"; userId: number; url: string };

export const fake = {
  users: [] as FakeUser[],
  albums: [] as FakeAlbum[],
  images: [] as FakeImage[],
  // "bucket/key" of each object S3 holds
  objects: new Set<string>(),
  events: [] as FakeEvent[],
  // Every statement sent, so a test can pin the filters in its text
  statements: [] as { sql: string; params: any[] }[],
  // A test sets these to hold an S3 call open, or to fail it. They run before
  // the call takes effect.
  beforePut: null as null | ((key: string) => Promise<void>),
  beforeDelete: null as null | ((keys: string[]) => Promise<void>),
  // A test sets this to hold the hide open. It runs before the hide.
  beforeHide: null as null | ((ids: string[]) => Promise<void>),
};

export function resetFakes(): void {
  fake.users = [];
  fake.albums = [];
  fake.images = [];
  fake.objects = new Set();
  fake.events = [];
  fake.statements = [];
  fake.beforePut = null;
  fake.beforeDelete = null;
  fake.beforeHide = null;
}

export function addUser(props: Partial<FakeUser> & { id: number }): FakeUser {
  const user: FakeUser = {
    uname: `user${props.id}`,
    approved_at: null,
    posts_count: 0,
    avatar_url: "",
    legacy_avatar_url: null,
    ...props,
  };
  fake.users.push(user);
  return user;
}

let imageSeq = 0;

// A stored album image row. Its object is not in the bucket unless a test
// adds it.
export function addImage(
  props: Partial<FakeImage> & { user_id: number },
): FakeImage {
  imageSeq += 1;
  const image: FakeImage = {
    id: `0190d5a0-0000-7000-8000-${String(imageSeq).padStart(12, "0")}`,
    album_id: 1,
    src: "https://img.roleplayerguild.com/prod/users/seeded.avif",
    mime: "image/avif",
    description: null,
    bytes: 0,
    deleted_at: null,
    created_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
    ...props,
  };
  fake.images.push(image);
  return image;
}

export function hasObject(bucket: string, key: string): boolean {
  return fake.objects.has(`${bucket}/${key}`);
}

////////////////////////////////////////////////////////////
// server/s3.ts

export const fakeS3 = {
  async putObject(
    bucket: string,
    key: string,
    _body: Buffer,
    _contentType: string,
  ): Promise<void> {
    if (fake.beforePut) await fake.beforePut(key);
    fake.objects.add(`${bucket}/${key}`);
    fake.events.push({ op: "put", bucket, key });
  },

  async deleteObjects(bucket: string, keys: string[]): Promise<void> {
    if (fake.beforeDelete) await fake.beforeDelete(keys);
    for (const key of keys) fake.objects.delete(`${bucket}/${key}`);
    fake.events.push({ op: "delete", bucket, keys });
  },
};

////////////////////////////////////////////////////////////
// server/db/util.ts

type Result = { rows: any[]; rowCount: number };

function result(rows: any[], rowCount = rows.length): Result {
  return { rows, rowCount };
}

async function query(sql: string, params: any[] = []): Promise<Result> {
  fake.statements.push({ sql, params });
  if (/pg_advisory_xact_lock/.test(sql)) return result([]);

  // lockStanding
  if (/SELECT id, uname, approved_at, posts_count\s+FROM users/.test(sql)) {
    return result(fake.users.filter((u) => u.id === params[0]));
  }

  if (/UPDATE users\s+SET avatar_url/.test(sql)) {
    const url = /avatar_url = \$2/.test(sql) ? (params[1] as string) : "";
    const user = fake.users.find((u) => u.id === params[0]);
    if (!user) return result([], 0);
    user.avatar_url = url;
    user.legacy_avatar_url = null;
    fake.events.push({ op: "avatar_url", userId: user.id, url });
    return result([], 1);
  }

  if (!/\bimages\b/.test(sql)) {
    // Another table, such as a statement of server/db/admin.ts#mergeUsers
    // that does not touch images. Nothing here models it.
    return result([], 0);
  }

  const owned = (userId: unknown) =>
    fake.images.filter((image) => image.user_id === userId);
  const live = (image: FakeImage) => image.deleted_at === null;

  if (/COUNT\(\*\) FILTER/.test(sql)) {
    const rows = owned(params[0]).filter(live);
    const bytes = rows.reduce((sum, image) => sum + image.bytes, 0);
    // pg returns a bigint as a string
    return result([{ images: rows.length, bytes: String(bytes) }]);
  }

  if (/SELECT created_at\s+FROM images/.test(sql)) {
    const since = Date.now() - (params[1] as number) * 1000;
    return result(
      owned(params[0])
        .filter((image) => image.created_at.getTime() > since)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((image) => ({ created_at: image.created_at })),
    );
  }

  if (/INSERT INTO images/.test(sql)) {
    const [id, albumId, ownerId, src, mime, description, bytes] = params;
    const album = fake.albums.find(
      (a) => a.id === albumId && a.user_id === ownerId,
    );
    if (!album) return result([], 0);
    fake.images.push({
      id,
      album_id: album.id,
      user_id: album.user_id,
      src,
      mime,
      description,
      bytes,
      deleted_at: null,
      created_at: new Date(),
    });
    fake.events.push({ op: "insert", id });
    return result([], 1);
  }

  if (/SELECT id\s+FROM images/.test(sql)) {
    const ids = /id = ANY/.test(sql) ? (params[1] as string[]) : null;
    return result(
      owned(params[0])
        .filter(live)
        .filter((image) => !ids || ids.includes(image.id))
        .map((image) => ({ id: image.id })),
    );
  }

  if (/UPDATE images\s+SET deleted_at = NOW\(\)/.test(sql)) {
    const ids = params[1] as string[];
    if (fake.beforeHide) await fake.beforeHide(ids);
    const hidden = owned(params[0])
      .filter(live)
      .filter((image) => ids.includes(image.id));
    for (const image of hidden) image.deleted_at = new Date();
    fake.events.push({ op: "hide", ids: hidden.map((image) => image.id) });
    return result(hidden.map((image) => ({ id: image.id })));
  }

  if (/UPDATE images\s+SET deleted_at = NULL/.test(sql)) {
    const ids = params[0] as string[];
    const shown = fake.images.filter((image) => ids.includes(image.id));
    for (const image of shown) image.deleted_at = null;
    fake.events.push({ op: "unhide", ids: shown.map((image) => image.id) });
    return result([], shown.length);
  }

  if (/SELECT deleted_at\s+FROM images/.test(sql)) {
    return result(
      fake.images
        .filter((image) => image.id === params[0])
        .map((image) => ({ deleted_at: image.deleted_at })),
    );
  }

  // server/db/admin.ts#mergeUsers moving the husk's images
  if (/UPDATE images\s+SET user_id = \$1\s+WHERE user_id = \$2/.test(sql)) {
    const moved = owned(params[1]);
    for (const image of moved) image.user_id = params[0] as number;
    return result([], moved.length);
  }

  throw new Error(`fake pg: no answer for this images statement: ${sql}`);
}

const client = { _inTransaction: true as const, query };

// Runs fn without a real transaction. storage.ts writes nothing before it
// refuses, so there is nothing to roll back.
async function withTransaction<T>(fn: (c: typeof client) => Promise<T>) {
  return fn(client);
}

const pool = { query, withTransaction };

export const fakeDbUtil = {
  pool,
  async withPgPoolTransaction<T>(
    _pool: unknown,
    fn: (c: typeof client) => Promise<T>,
  ): Promise<T> {
    return withTransaction(fn);
  },
  maybeOneRow(res: Result) {
    if (res.rows.length > 1) throw new Error("Expected at most one row");
    return res.rows[0];
  },
  exactlyOneRow(res: Result) {
    if (res.rows.length !== 1) throw new Error("Expected exactly one row");
    return res.rows[0];
  },
};
