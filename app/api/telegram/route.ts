import { NextResponse } from "next/server";
import { getAgent } from "@/lib/scan";
import { proveAgent } from "@/lib/probe";
import { originOf } from "@/lib/origin";
import { parseCommand, HELP, usageOf, addWatch, removeWatch, watchesOf, noteOutcome, sendTelegram, botEnabled } from "@/lib/watch";

/**
 * The Telegram bot's webhook.
 *
 * Telegram sends every message here with the secret the webhook was set up
 * with (`npm run telegram -- --set-webhook`); anything without it is not
 * Telegram and gets nothing. The reply goes out as its own sendMessage rather
 * than in the response body, so a slow agent does not hold Telegram's request.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Update = { message?: { chat?: { id?: number | string }; text?: string } };

export async function POST(request: Request) {
  if (!botEnabled()) return NextResponse.json({ error: "the Telegram bot is not configured" }, { status: 503 });
  if (request.headers.get("x-telegram-bot-api-secret-token") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }
  const update = (await request.json().catch(() => null)) as Update | null;
  const chatId = update?.message?.chat?.id;
  const text = update?.message?.text;
  if (chatId === undefined || typeof text !== "string") return NextResponse.json({ ok: true });
  const chat = String(chatId);
  const cmd = parseCommand(text);

  let reply: string;
  if (cmd.kind === "help") {
    reply = HELP;
  } else if (cmd.kind === "usage") {
    reply = usageOf(cmd.verb);
  } else if (cmd.kind === "list") {
    const mine = await watchesOf(chat);
    reply = mine.length
      ? `This chat watches:\n${mine.map((w) => `• ${w.chainId}:${w.tokenId}`).join("\n")}`
      : "This chat watches nothing yet. Try /watch 56 43129";
  } else if (cmd.kind === "unwatch") {
    reply = (await removeWatch(chat, cmd.chainId, cmd.tokenId))
      ? `Stopped watching ${cmd.chainId}:${cmd.tokenId}.`
      : `This chat was not watching ${cmd.chainId}:${cmd.tokenId}.`;
  } else {
    const agent = await getAgent(cmd.chainId, cmd.tokenId).catch(() => null);
    if (!agent) {
      reply = `No agent ${cmd.chainId}:${cmd.tokenId} in the registry.`;
    } else {
      const added = await addWatch(chat, cmd.chainId, cmd.tokenId);
      if (added === "full") reply = "This chat already watches 10 agents; /unwatch one first.";
      else if (added === "unavailable") reply = "Kawal's store could not be reached just now. Try again in a minute.";
      else {
        // The baseline is set from a call made now, so the first alert is a
        // real change and not the first reading.
        const proof = await proveAgent(agent).catch(() => null);
        if (proof) await noteOutcome(chat, cmd.chainId, cmd.tokenId, proof.answered);
        const now = proof
          ? proof.answered
            ? `It answered just now (${proof.latencyMs} ms).`
            : "It did not answer just now."
          : "It declares nothing Kawal can call, so there will be nothing to report.";
        reply =
          `${added === "exists" ? "Already watching" : "Watching"} ${agent.name} (${cmd.chainId}:${cmd.tokenId}). ${now}\n` +
          `You will hear from Kawal when that changes. ${originOf(request)}/agents/${cmd.chainId}/${cmd.tokenId}`;
      }
    }
  }
  await sendTelegram(chat, reply);
  return NextResponse.json({ ok: true });
}
