/**
 * Telegram alerts: tell an agent's owner when Kawal's calls to it change outcome.
 *
 * An owner learns their endpoint died when a buyer says so, if ever. Kawal
 * already calls it on a schedule. So a chat can ask the bot to watch an
 * agent (`/watch 56 43129`), the daily sweep calls every watched agent
 * first, and a change — answering to silent, or back — becomes one message.
 * No message when nothing changed: an alert that fires every day is muted
 * by the second.
 *
 * Needs TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_WEBHOOK_SECRET;
 * without them the bot is simply off and the sweep behaves as before.
 * Storage is the same store as the probe history, through `lib/db.ts`.
 */

import { openStore, type Store } from "./db.ts";

const MAX_WATCHES_PER_CHAT = 10;

let ready: Promise<Store | null> | null = null;

function open(): Promise<Store | null> {
  ready ??= (async () => {
    const store = await openStore(process.env.KAWAL_UPTIME_DB ?? ".kawal-uptime.db");
    if (!store) return null;
    try {
      await store.exec(`
        CREATE TABLE IF NOT EXISTS watch (
          chat_id       TEXT    NOT NULL,
          chain_id      INTEGER NOT NULL,
          token_id      TEXT    NOT NULL,
          last_answered INTEGER,
          created_at    INTEGER NOT NULL,
          PRIMARY KEY (chat_id, chain_id, token_id)
        )
      `);
      return store;
    } catch {
      return null;
    }
  })();
  return ready;
}

export function resetWatchForTests() {
  ready = null;
}

export type Command =
  | { kind: "watch"; chainId: number; tokenId: string }
  | { kind: "unwatch"; chainId: number; tokenId: string }
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "usage"; verb: "watch" | "unwatch" };

const AGENT_URL = /\/agents\/(\d+)\/(\d+)(?!\d)/;

/**
 * A chat message to a command. Accepts `/watch 56 43129`, `/watch 56:43129`,
 * a pasted agent URL, and the deep-link form `/start 56_43129` that a
 * t.me/<bot>?start= link sends. A pasted agent URL on its own, with no
 * command, is a /watch: that is what someone pasting one means. Anything else
 * is a request for help.
 */
export function parseCommand(text: string): Command {
  const t = text.trim();
  const m = /^\/(watch|unwatch|start|list|help)(?:@\w+)?\s*([\s\S]*)$/i.exec(t) ?? (AGENT_URL.test(t) ? [t, "watch", t] : null);
  if (!m) return { kind: "help" };
  const verb = m[1]!.toLowerCase();
  if (verb === "list") return { kind: "list" };
  if (verb === "help") return { kind: "help" };
  // A URL is read by its path, so a trailing slash, a query or a fragment
  // (share links carry them) does not hide the agent it names.
  const ref = AGENT_URL.exec(m[2] ?? "") ?? /(\d+)\s*[\s:_/]\s*(\d+)\s*$/.exec(m[2] ?? "");
  // A bare /start is someone opening the bot, so they get the help. A /watch
  // that names no agent Kawal reads is told what is missing instead.
  const usage: Command = verb === "start" ? { kind: "help" } : { kind: "usage", verb: verb as "watch" | "unwatch" };
  if (!ref) return usage;
  const chainId = Number(ref[1]);
  const tokenId = ref[2]!;
  if (chainId !== 56 && chainId !== 97) return usage;
  return { kind: verb === "unwatch" ? "unwatch" : "watch", chainId, tokenId };
}

export const usageOf = (verb: "watch" | "unwatch") =>
  `Which agent? Send /${verb} 56 43129 (chain id, then token id) or paste its Kawal page URL. Kawal reads BSC (56) and BSC testnet (97).`;

export const HELP =
  "Kawal watches ERC-8004 agents on BNB Smart Chain and tells you when its calls to one change outcome.\n\n" +
  "/watch 56 43129 — watch an agent (or paste its kawal page URL)\n" +
  "/unwatch 56 43129 — stop\n" +
  "/list — what this chat watches\n\n" +
  "Checked once a day by Kawal's scheduled sweep, from one vantage point.";

/** The alert for a change, or null when there is nothing to say. */
export function transition(name: string, ref: string, before: boolean | null, now: boolean): string | null {
  if (before === null || before === now) return null;
  return now
    ? `✅ ${name} (${ref}) answers again. Kawal's scheduled call just got a reply.`
    : `⚠️ ${name} (${ref}) stopped answering. Kawal's scheduled call got no reply in its declared protocol.`;
}

export async function addWatch(chatId: string, chainId: number, tokenId: string): Promise<"added" | "exists" | "full" | "unavailable"> {
  const store = await open();
  if (!store) return "unavailable";
  const count = await store.get<{ n: number }>("SELECT COUNT(*) AS n FROM watch WHERE chat_id = ?", [chatId]);
  const exists = await store.get("SELECT 1 FROM watch WHERE chat_id = ? AND chain_id = ? AND token_id = ?", [chatId, chainId, tokenId]);
  if (exists) return "exists";
  if (Number(count?.n ?? 0) >= MAX_WATCHES_PER_CHAT) return "full";
  await store.run("INSERT INTO watch (chat_id, chain_id, token_id, last_answered, created_at) VALUES (?, ?, ?, NULL, ?)", [
    chatId,
    chainId,
    tokenId,
    Math.floor(Date.now() / 1000),
  ]);
  return "added";
}

export async function removeWatch(chatId: string, chainId: number, tokenId: string): Promise<boolean> {
  const store = await open();
  if (!store) return false;
  const r = await store.run("DELETE FROM watch WHERE chat_id = ? AND chain_id = ? AND token_id = ?", [chatId, chainId, tokenId]);
  return r.changes > 0;
}

export async function watchesOf(chatId: string): Promise<Array<{ chainId: number; tokenId: string }>> {
  const store = await open();
  if (!store) return [];
  const rows = await store.all<{ chain_id: number; token_id: string }>("SELECT chain_id, token_id FROM watch WHERE chat_id = ?", [chatId]);
  return rows.map((r) => ({ chainId: Number(r.chain_id), tokenId: String(r.token_id) }));
}

/** Every watched agent, once each, with the chats watching it. */
export async function watchedAgents(): Promise<Array<{ chainId: number; tokenId: string; chats: Array<{ chatId: string; lastAnswered: boolean | null }> }>> {
  const store = await open();
  if (!store) return [];
  const rows = await store.all<{ chat_id: string; chain_id: number; token_id: string; last_answered: number | null }>(
    "SELECT chat_id, chain_id, token_id, last_answered FROM watch",
  );
  const byAgent = new Map<string, { chainId: number; tokenId: string; chats: Array<{ chatId: string; lastAnswered: boolean | null }> }>();
  for (const r of rows) {
    const key = `${r.chain_id}:${r.token_id}`;
    const entry = byAgent.get(key) ?? { chainId: Number(r.chain_id), tokenId: String(r.token_id), chats: [] };
    entry.chats.push({ chatId: String(r.chat_id), lastAnswered: r.last_answered === null ? null : Number(r.last_answered) === 1 });
    byAgent.set(key, entry);
  }
  return [...byAgent.values()];
}

export async function noteOutcome(chatId: string, chainId: number, tokenId: string, answered: boolean): Promise<void> {
  const store = await open();
  if (!store) return;
  await store.run("UPDATE watch SET last_answered = ? WHERE chat_id = ? AND chain_id = ? AND token_id = ?", [
    answered ? 1 : 0,
    chatId,
    chainId,
    tokenId,
  ]);
}

/** One message to one chat. Returns whether Telegram accepted it. */
export async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function botEnabled(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_WEBHOOK_SECRET);
}
