import crypto from "crypto";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { log } from "./logger";

export interface IncomingMedia {
  id: string; // Meta media id, used to download the actual bytes
  mimeType: string;
  filename?: string; // only present for documents
}

export interface IncomingMessage {
  from: string; // sender's number, digits only (Meta's format)
  text: string; // body text, or the caption for media messages (may be empty)
  id: string;
  media?: IncomingMedia;
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

// Media message types the Cloud API can deliver; each carries { id, mime_type, ... } under the
// key of the same name (documents additionally carry filename, most carry an optional caption).
const MEDIA_TYPES = ["image", "document", "audio", "video", "sticker"] as const;

/** Extracts text and media messages from a Meta Cloud API webhook payload. Ignores statuses/other event types. */
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
        } else if (MEDIA_TYPES.includes(msg.type) && msg[msg.type]?.id) {
          const m = msg[msg.type];
          messages.push({
            from: msg.from,
            text: m.caption || "",
            id: msg.id,
            media: { id: m.id, mimeType: m.mime_type || "application/octet-stream", filename: m.filename },
          });
        }
      }
    }
  }
  return messages;
}

/** Downloads a received media file's bytes: resolve the media id to a short-lived CDN url, then
 *  fetch it (both calls authenticated with the same access token). */
export async function downloadMedia(media: IncomingMedia): Promise<Buffer> {
  const auth = { Authorization: `Bearer ${config.whatsapp.accessToken}` };
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${media.id}`, { headers: auth });
  if (!metaRes.ok) throw new Error(`media lookup failed: ${metaRes.status} ${await metaRes.text()}`);
  const meta: any = await metaRes.json();
  const fileRes = await fetch(meta.url, { headers: auth });
  if (!fileRes.ok) throw new Error(`media download failed: ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
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

// --- outbound files ---

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
};

// What WhatsApp will render inline; everything else goes out as a document attachment.
const IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const VIDEO_MIMES = new Set(["video/mp4", "video/3gpp"]);
const AUDIO_MIMES = new Set(["audio/mpeg", "audio/ogg", "audio/mp4", "audio/aac", "audio/amr"]);

// WhatsApp caps media uploads at 100MB (documents); images/videos have lower caps but oversized
// uploads fail with a clear API error we surface to the user anyway.
const MAX_FILE_BYTES = 99 * 1024 * 1024;

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** Uploads a local file to WhatsApp's media endpoint, returning the media id to send with. */
async function uploadMedia(filePath: string, mime: string): Promise<string> {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mime);
  form.append("file", new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
  const url = `https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}` },
    body: form,
  });
  const bodyText = await res.text();
  if (!res.ok) {
    log("whatsapp_upload_failed", { filePath, status: res.status, bodyText });
    throw new Error(`WhatsApp media upload failed: ${res.status} ${bodyText}`);
  }
  return JSON.parse(bodyText).id;
}

/** Sends a local file to a WhatsApp number, as an inline image/video/audio when the type allows
 *  it, otherwise as a document attachment with its filename. */
export async function sendFile(to: string, filePath: string, caption?: string): Promise<void> {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs); // throws with a readable error if the path doesn't exist
  if (!stat.isFile()) throw new Error(`${abs} is not a file`);
  if (stat.size > MAX_FILE_BYTES) throw new Error(`file exceeds WhatsApp's 100MB media limit`);

  const mime = mimeFor(abs);
  const mediaId = await uploadMedia(abs, mime);
  const kind = IMAGE_MIMES.has(mime)
    ? "image"
    : VIDEO_MIMES.has(mime)
    ? "video"
    : AUDIO_MIMES.has(mime)
    ? "audio"
    : "document";

  const mediaPayload: any = { id: mediaId };
  if (kind === "document") mediaPayload.filename = path.basename(abs);
  if (caption && kind !== "audio") mediaPayload.caption = caption;

  const res = await fetch(`https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.whatsapp.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", to, type: kind, [kind]: mediaPayload }),
  });
  if (!res.ok) {
    const errBody = await res.text();
    log("whatsapp_send_file_failed", { to, filePath: abs, status: res.status, errBody });
    throw new Error(`WhatsApp file send failed: ${res.status} ${errBody}`);
  }
  log("whatsapp_file_sent", { to, filePath: abs, kind, bytes: stat.size });
}
