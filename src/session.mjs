import crypto from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MASK = (1n << 48n) - 1n;

let lastTs = 0;
let counter = 0;

/**
 * OpenCode session ids are `ses_` + 12 hex chars of a descending 48-bit
 * timestamp/counter + 14 base62 random chars. Upstream decodes the timestamp
 * and rejects ids whose time is not current, so mint with Date.now().
 */
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

const TTL_MS = Number(process.env.SHIM_SESSION_TTL_MS || 10 * 60 * 1000);
const MAX_SESSIONS = 2000;
const store = new Map();

function keyOf(body) {
  const explicit = body?.prompt_cache_key || body?.session_id || body?.conversation_id;
  if (typeof explicit === "string" && explicit.trim()) return "k:" + explicit.trim().slice(0, 200);
  const seed = JSON.stringify([
    body?.model || "",
    Array.isArray(body?.messages) ? body.messages.slice(0, 2) : body?.input || "",
  ]);
  return "h:" + crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** Stable session per conversation, refreshed once it gets old. */
export function sessionFor(body) {
  const key = keyOf(body);
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.created < TTL_MS) {
    hit.lastUsed = now;
    return hit.id;
  }
  const id = generateSessionId(now);
  if (store.size >= MAX_SESSIONS) store.delete(store.keys().next().value);
  store.set(key, { id, created: now, lastUsed: now });
  return id;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now - entry.lastUsed > TTL_MS * 2) store.delete(key);
  }
}, 60_000).unref?.();
