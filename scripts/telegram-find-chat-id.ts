/**
 * Helper to find your Telegram chat ID after creating a bot.
 *
 * Usage:
 *   1. In Telegram, open your bot (search by username) and send it ANY message,
 *      e.g. "hi" or "/start". Telegram won't expose the chat to the bot until
 *      you initiate the conversation — this is the most common reason
 *      getUpdates returns empty.
 *   2. Run this script:
 *        npx tsx scripts/telegram-find-chat-id.ts                     (reads TELEGRAM_BOT_TOKEN from .env)
 *        TELEGRAM_BOT_TOKEN=123:abc npx tsx scripts/telegram-find-chat-id.ts
 *        npx tsx scripts/telegram-find-chat-id.ts <token>             (passes token via argv)
 *   3. Copy the chat ID printed and paste it into .env as TELEGRAM_CHAT_ID.
 *
 * For a private chat with the bot, the chat ID is the same as your Telegram
 * user ID (a positive integer). For groups, it's a negative integer.
 */

import "../src/config.js";
import { fetchJson } from "../src/http.js";

interface Update {
  update_id: number;
  message?: {
    chat: { id: number; type: string; first_name?: string; username?: string; title?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    date: number;
  };
}

interface UpdatesResp {
  ok: boolean;
  result?: Update[];
  description?: string;
}

async function main(): Promise<void> {
  const token = process.argv[2] ?? process.env.TELEGRAM_BOT_TOKEN ?? "";
  if (!token) {
    process.stderr.write(
      "No token. Pass it as argv (npx tsx scripts/telegram-find-chat-id.ts <token>) or set TELEGRAM_BOT_TOKEN in .env.\n",
    );
    process.exit(1);
  }

  process.stdout.write("Fetching updates from Telegram...\n\n");

  let resp: UpdatesResp;
  try {
    resp = await fetchJson<UpdatesResp>(`https://api.telegram.org/bot${token}/getUpdates`);
  } catch (e) {
    process.stderr.write(`API call failed: ${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }

  if (!resp.ok) {
    process.stderr.write(`Telegram returned not-ok: ${resp.description ?? "(no description)"}\n`);
    process.exit(1);
  }

  const updates = resp.result ?? [];
  if (updates.length === 0) {
    process.stdout.write(
      "No updates yet. Telegram only releases messages once you initiate the chat:\n" +
        "  1. Open Telegram, search for your bot by its @username\n" +
        "  2. Press Start, or send any message like \"hi\"\n" +
        "  3. Re-run this script\n\n" +
        "If you already messaged the bot, try sending another one — getUpdates only\n" +
        "returns recent activity (the offset advances as Telegram considers updates seen).\n",
    );
    return;
  }

  // Deduplicate by chat ID so we don't print the same chat multiple times.
  const seen = new Map<number, { type: string; label: string; lastText: string }>();
  for (const u of updates) {
    const m = u.message;
    if (!m) continue;
    const id = m.chat.id;
    const label =
      m.chat.title ??
      m.chat.username ??
      m.chat.first_name ??
      `(${m.chat.type})`;
    seen.set(id, { type: m.chat.type, label, lastText: m.text ?? "(no text)" });
  }

  process.stdout.write(`Found ${seen.size} chat(s):\n\n`);
  for (const [id, info] of seen) {
    process.stdout.write(`  chat ID:   ${id}\n`);
    process.stdout.write(`  type:      ${info.type}\n`);
    process.stdout.write(`  label:     ${info.label}\n`);
    process.stdout.write(`  last msg:  ${info.lastText.slice(0, 80)}\n\n`);
  }

  // Most common case: user has one private chat → ready to paste.
  if (seen.size === 1) {
    const [id] = seen.keys();
    process.stdout.write(
      `Single chat — paste this into .env:\n\n  TELEGRAM_CHAT_ID=${id}\n`,
    );
  } else {
    process.stdout.write(
      `Multiple chats. Pick the one you want notifications in (private chat = your\n` +
        `user id, positive integer) and paste it into .env as TELEGRAM_CHAT_ID.\n`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
