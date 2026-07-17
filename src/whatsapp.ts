import crypto from "crypto";
import { config } from "./config";
import { log } from "./logger";

export interface IncomingMessage {
  from: string; // sender's number, digits only (Meta's format)
  text: string;
  id: string;
}

/** Handles GET /webhook Meta verification handshake. Returns the challenge string to echo back, or null if invalid. */
export function handleVerification(query: Record<string, unknown>): string | null {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode === "subscribe" && token === config.whatsapp.verifyToken && typeof challenge === "string") {
    return challenge;
  }
  return null;
}

/** Verifies Meta's X-Hub-Signature-256 header against the raw request body. Always enforced. */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", config.whatsapp.appSecret)
    .update(rawBody)
    .digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}

/** Extracts text messages from a Meta Cloud API webhook payload. Ignores statuses/other event types. */
export function parseIncoming(body: any): IncomingMessage[] {
  const messages: IncomingMessage[] = [];
  const entries = body?.entry || [];
  for (const entry of entries) {
    const changes = entry?.changes || [];
    for (const change of changes) {
      const value = change?.value;
      const msgs = value?.messages || [];
      for (const msg of msgs) {
        if (msg.type === "text" && msg.text?.body) {
          messages.push({ from: msg.from, text: msg.text.body, id: msg.id });
        }
      }
    }
  }
  return messages;
}

// WhatsApp caps a text message body at 4096 chars; stay under it with headroom.
const WHATSAPP_MAX_BODY = 3900;

/** Splits long text on line/word boundaries so a big Claude summary doesn't exceed WhatsApp's limit. */
export function chunkText(text: string, max = WHATSAPP_MAX_BODY): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > max) {
    let cut = remaining.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = remaining.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendOne(to: string, body: string): Promise<void> {
  const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body, preview_url: false },
    }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    log("whatsapp_send_failed", { to, status: res.status, errBody });
    throw new Error(`WhatsApp send failed: ${res.status} ${errBody}`);
  }
}

export async function sendText(to: string, body: string): Promise<void> {
  const parts = chunkText(body || "(no content)");
  for (const part of parts) {
    await sendOne(to, part);
  }
}
