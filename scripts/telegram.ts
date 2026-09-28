/**
 * Sets up the Telegram bot that alerts owners when Kawal's calls to their agent change outcome.
 *
 * Run: npm run telegram                              who the bot is, and where its webhook points
 *      npm run telegram -- --set-webhook [origin]    points the webhook at {origin}/api/telegram
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local. The
 * same two, plus TELEGRAM_BOT_USERNAME for the page's "watch" link, go into
 * the deployment's environment.
 */

export {};

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!token || !secret) {
  console.error("Set TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_WEBHOOK_SECRET (any long random string) in .env.local.\n");
  process.exit(1);
}

async function call(method: string, body?: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

const me = (await call("getMe")) as { username: string };
console.log(`bot       @${me.username}   (TELEGRAM_BOT_USERNAME=${me.username})`);

const at = process.argv.indexOf("--set-webhook");
if (at > -1) {
  const origin = process.argv[at + 1]?.startsWith("http") ? process.argv[at + 1]! : "https://kawal-three.vercel.app";
  const url = `${origin.replace(/\/$/, "")}/api/telegram`;
  await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: true });
  await call("setMyCommands", {
    commands: [
      { command: "watch", description: "Watch an agent: /watch 56 43129" },
      { command: "unwatch", description: "Stop watching: /unwatch 56 43129" },
      { command: "list", description: "What this chat watches" },
      { command: "help", description: "How this works" },
    ],
  });
  console.log(`webhook   set to ${url}`);
}

const info = (await call("getWebhookInfo")) as { url: string; pending_update_count: number; last_error_message?: string };
console.log(`webhook   ${info.url || "(none)"}   pending ${info.pending_update_count}${info.last_error_message ? `   last error: ${info.last_error_message}` : ""}\n`);
