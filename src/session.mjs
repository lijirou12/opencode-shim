import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK = (1n << 48n) - 1n;

let lastTs = 0;
let counter = 0;

/** Mint the measured OpenCode-style timestamp/session id shape. */
export function generateSessionId(ts = Date.now()) {
  if (ts !== lastTs) {
    lastTs = ts;
    counter = 0;
  }
  counter += 1;
  const prefix = (~(BigInt(ts) * 0x1000n + BigInt(counter)) & MASK)
    .toString(16)
    .padStart(12, "0");
  const bytes = crypto.randomBytes(14);
  let suffix = "";
  for (let i = 0; i < 14; i++) suffix += BASE62[bytes[i] % 62];
  return `ses_${prefix}${suffix}`;
}

/** A fresh request-scoped id is required by this upstream lane. */
const sessionStore = new Map();
const SESSION_TTL_MS = Number(process.env.SHIM_SESSION_TTL_MS || 2 * 60 * 60 * 1000);
const MAX_SESSIONS = 5000;

/** Keep one valid upstream session stable per downstream conversation. */
export function sessionFor(body = {}) {
  const explicit = body.prompt_cache_key || body.session_id || body.conversation_id;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const conversation = messages
    .filter((message) => message?.role === "user")
    .slice(0, 1)
    .map((message) => message?.content ?? "");
  const seed = typeof explicit === "string" && explicit.trim()
    ? explicit.trim()
    : JSON.stringify([body.model || "", conversation]);
  const key = seed.slice(0, 512);
  const now = Date.now();
  const hit = sessionStore.get(key);
  if (hit && now - hit.lastUsed < SESSION_TTL_MS) {
    hit.lastUsed = now;
    return hit.id;
  }
  const id = generateSessionId(now);
  if (sessionStore.size >= MAX_SESSIONS) sessionStore.delete(sessionStore.keys().next().value);
  sessionStore.set(key, { id, lastUsed: now });
  return id;
}