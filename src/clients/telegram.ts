/**
 * Telegram Bot API — sendMessage helper.
 * Uses TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID from env.
 */
import { config } from "../config.js";
import { fetchJson } from "../http.js";

interface SendMessageResp { ok: boolean; result?: { message_id: number }; description?: string; }

export interface SendOpts {
  parse_mode?: "Markdown" | "MarkdownV2" | "HTML";
  disable_notification?: boolean;
  disable_web_page_preview?: boolean;
}

export async function sendTelegram(text: string, opts: SendOpts = {}): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const token = config.telegramToken;
  const chatId = config.telegramChatId;
  if (!token || !chatId) return { ok: false, error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set" };

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode ?? "Markdown",
    disable_notification: opts.disable_notification ?? false,
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
  });
  try {
    const resp = await fetchJson<SendMessageResp>(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return resp.ok
      ? { ok: true, messageId: resp.result?.message_id }
      : { ok: false, error: resp.description };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Escape MarkdownV2 special characters. */
export function escMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}
