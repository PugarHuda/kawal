/**
 * One way to open a table, whichever machine this is running on.
 *
 * Kawal keeps three things that outlive a request: every probe it has made,
 * every payment receipt it has accepted, and the ledger of seats it granted.
 * On a machine with a disk those are SQLite files, chosen over a real database
 * because a marketplace that needs Postgres running to render a page is a
 * worse marketplace. On a platform without a disk — every serverless host —
 * a file resets on each cold start, and a probe history that resets is not a
 * history.
 *
 * So the dialect stays SQLite and the file becomes optional. With
 * `TURSO_DATABASE_URL` set, every store talks to one libSQL database over
 * HTTP; without it, each store opens its own file as before. The SQL is the
 * same in both cases. Nothing above this module knows which it got.
 *
 * The price is that the API is async even when the file underneath is not.
 * `node:sqlite` answers synchronously and libSQL cannot, so the callers all
 * await — which they already could, since every one of them is a server
 * component, a route handler or a script.
 */

import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join } from "node:path";

export type Row = Record<string, unknown>;

export type Store = {
  exec(sql: string): Promise<void>;
  run(sql: string, args?: unknown[]): Promise<{ changes: number }>;
  get<T extends Row = Row>(sql: string, args?: unknown[]): Promise<T | undefined>;
  all<T extends Row = Row>(sql: string, args?: unknown[]): Promise<T[]>;
};

/** Whether stores go to the shared remote database rather than local files. */
export function isRemote(): boolean {
  return typeof process.env.TURSO_DATABASE_URL === "string" && process.env.TURSO_DATABASE_URL !== "";
}

/** Where a store lives when it is a file. */
export function resolvePath(configured: string): string {
  // Anchored to the working directory: a relative path follows the process,
  // and a server started from elsewhere would silently open a second, empty
  // history instead of the real one.
  return isAbsolute(configured) ? configured : join(process.cwd(), configured);
}

/* ------------------------------------------------------------- local --- */

function local(file: string): Store {
  const db = new DatabaseSync(resolvePath(file));
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, args = []) {
      const r = db.prepare(sql).run(...(args as never[]));
      return { changes: Number(r.changes) };
    },
    async get(sql, args = []) {
      return db.prepare(sql).get(...(args as never[])) as never;
    },
    async all(sql, args = []) {
      return db.prepare(sql).all(...(args as never[])) as never;
    },
  };
}

/* ------------------------------------------------------------ remote --- */

let remoteClient: import("@libsql/client").Client | null = null;

async function remote(): Promise<Store> {
  if (!remoteClient) {
    const { createClient } = await import("@libsql/client");
    remoteClient = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  const client = remoteClient;
  // libSQL hands back bigint for wide integers unless told otherwise, and the
  // callers compare against numbers. Everything Kawal stores fits.
  const args = (a: unknown[]) => a.map((v) => (typeof v === "bigint" ? Number(v) : v)) as never[];
  return {
    async exec(sql) {
      // `exec` may carry several statements; libSQL wants them one at a time.
      for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
        await client.execute(statement);
      }
    },
    async run(sql, a = []) {
      const r = await client.execute({ sql, args: args(a) });
      return { changes: r.rowsAffected };
    },
    async get(sql, a = []) {
      const r = await client.execute({ sql, args: args(a) });
      return r.rows[0] as never;
    },
    async all(sql, a = []) {
      const r = await client.execute({ sql, args: args(a) });
      return r.rows as never;
    },
  };
}

/* -------------------------------------------------------------- open --- */

const opened = new Map<string, Promise<Store | null>>();

/**
 * Opens a store, creating it on first use.
 *
 * Null rather than a throw when it cannot be opened — a read-only filesystem,
 * a bad URL — so a broken store costs the panel it feeds and not the page. The
 * failure is latched: a broken environment is not retried on every render.
 */
export function openStore(localFile: string): Promise<Store | null> {
  const key = isRemote() ? "remote" : localFile;
  let pending = opened.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        return isRemote() ? await remote() : local(localFile);
      } catch {
        return null;
      }
    })();
    opened.set(key, pending);
  }
  return pending;
}

/** Only for the offline suite, which points stores at scratch files. */
export function resetStoresForTests() {
  opened.clear();
}
