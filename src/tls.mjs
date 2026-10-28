import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Cipher list from the OpenCode/Bun client. The free-tier gate fingerprints the
// TLS ClientHello, so this must match byte for byte.
const CIPHER_LIST = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-ECDSA-AES128-SHA",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-ECDSA-AES256-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const sessions = new Map();
const MAX_SESSIONS = 16;

function loadWreq() {
  const mod = require("wreq-js");
  return mod?.default?.createSession ? mod.default : mod;
}

async function getSession(proxyUrl = "") {
  const key = proxyUrl || "";
  if (sessions.has(key)) return sessions.get(key);
  const wreq = loadWreq();
  if (typeof wreq.createSession !== "function") {
    throw new Error("wreq-js is missing createSession");
  }
  const promise = wreq
    .createSession({
      ...(key ? { proxy: key } : {}),
      emulation: { tlsOptions: { cipherList: CIPHER_LIST } },
    })
    .catch((error) => {
      sessions.delete(key);
      throw error;
    });
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.get(oldest)?.then((s) => s.close?.()).catch(() => {});
    sessions.delete(oldest);
  }
  sessions.set(key, promise);
  return promise;
}

export async function tlsFetch(url, init = {}, { timeoutMs = 300000, proxyUrl = "" } = {}) {
  const session = await getSession(proxyUrl);
  const options = {
    method: init.method || "GET",
    headers: init.headers,
    redirect: "follow",
    timeout: timeoutMs,
  };
  if (init.body !== undefined) options.body = init.body;
  if (init.signal) options.signal = init.signal;
  const res = await session.fetch(url, options);
  const headers = {};
  res.headers?.forEach?.((value, key) => {
    headers[key] = value;
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
