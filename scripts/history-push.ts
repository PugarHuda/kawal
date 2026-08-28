/**
 * Copies this machine's probe history into the deployed site's database.
 *
 * Run: npm run history:push     (needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN)
 *
 * The live site starts with an empty history, and a history is the one thing
 * Kawal holds that nobody else does. Every probe made from here since the
 * 26th is a real observation of a real endpoint; the deployed site should
 * begin from them rather than from nothing.
 *
 * Rows are keyed by endpoint and second, so running this twice adds nothing
 * the second time. Both sides are read through the same store layer — the
 * file is opened by path, the remote by environment — and the SQL is the one
 * the uptime module writes.
 */

export {};

import { DatabaseSync } from "node:sqlite";
import { isRemote, openStore, resolvePath } from "../lib/db.ts";

if (!isRemote()) {
  console.error("No remote store is configured. Set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN) and run again.\n");
  process.exit(1);
}

type Row = { endpoint: string; checked_at: number; is_mcp: number; latency_ms: number; error: string | null; protocol: string };

const local = new DatabaseSync(resolvePath(process.env.KAWAL_UPTIME_DB ?? ".kawal-uptime.db"));
const rows = local.prepare("SELECT endpoint, checked_at, is_mcp, latency_ms, error, protocol FROM probe ORDER BY checked_at").all() as Row[];
console.log(`local history: ${rows.length} probe(s) across ${new Set(rows.map((r) => r.endpoint)).size} endpoint(s)`);

const remote = await openStore(".kawal-uptime.db");
if (!remote) {
  console.error("The remote store could not be opened.\n");
  process.exit(1);
}
await remote.exec(`
  CREATE TABLE IF NOT EXISTS probe (
    endpoint   TEXT    NOT NULL,
    checked_at INTEGER NOT NULL,
    is_mcp     INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    error      TEXT,
    protocol   TEXT    NOT NULL DEFAULT 'mcp'
  );
  CREATE INDEX IF NOT EXISTS probe_endpoint_time ON probe (endpoint, checked_at)
`);

const before = Number((await remote.get<{ n: number }>("SELECT COUNT(*) AS n FROM probe"))?.n ?? 0);

let copied = 0;
for (const r of rows) {
  const dup = await remote.get("SELECT 1 AS x FROM probe WHERE endpoint = ? AND checked_at = ? LIMIT 1", [r.endpoint, r.checked_at]);
  if (dup) continue;
  await remote.run(
    "INSERT INTO probe (endpoint, checked_at, is_mcp, latency_ms, error, protocol) VALUES (?, ?, ?, ?, ?, ?)",
    [r.endpoint, r.checked_at, r.is_mcp, r.latency_ms, r.error, r.protocol ?? "mcp"],
  );
  copied++;
}

const after = Number((await remote.get<{ n: number }>("SELECT COUNT(*) AS n FROM probe"))?.n ?? 0);
console.log(`remote history: ${before} → ${after} probe(s); ${copied} copied, ${rows.length - copied} already there`);
