#!/usr/bin/env node
/**
 * OpenAI-compatible gateway for the OpenCode free tier.
 *
 * It calls OpenCode's inference API directly (no CLI subprocess): the free-tier
 * gate is satisfied in-request by the OpenCode tool declarations, the env
 * system block, a freshly minted `ses_...` id mirrored into four headers and
 * `prompt_cache_key`, and an impersonated TLS ClientHello (wreq-js).
 */
import http from "node:http";
import crypto from "node:crypto";
import { sessionFor } from "./src/session.mjs";
import { tlsFetch } from "./src/tls.mjs";
import {
  buildTools,
  injectSystem,
  placeholderNote,
  appendSystemNote,
  restoreName,
  isPlaceholderCall,
  injectReasoningPlaceholder,
  OFFICIAL_NAMES,
} from "./src/fingerprint.mjs";

const VERSION = "3.0.0";
const PORT = Number(process.env.SHIM_PORT || 18001);
const BIND = process.env.SHIM_BIND || "0.0.0.0";
const TOKEN = (process.env.SHIM_TOKEN || "").trim();
const UPSTREAM = (process.env.SHIM_UPSTREAM || "https://opencode.ai").replace(/\/+$/, "");
const PROXY = (process.env.SHIM_PROXY || "").trim();
const TIMEOUT_MS = Number(process.env.SHIM_TIMEOUT || 300) * 1000;
const UA = process.env.SHIM_UA || "opencode/latest/2.0.26/cli";

if (!TOKEN) {
  console.error("[gateway] SHIM_TOKEN is required");
  process.exit(1);
}

const FALLBACK_MODELS = [
  "big-pickle",
  "beam-free",
  "flint-40b-free",
  "mimo-v2.6-flash-free",
  "nemotron-3.5-super-vl-free",
  "nemotron-3.5-lightning-free",
  "nemotron-3-ultra-free",
  "deepseek-v4.1-flash-free",
  "glm-5.3-flash-free",
];

function upstreamHeaders(session, stream = true) {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer public",
    "User-Agent": UA,
    "x-opencode-client": "cli",
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-id": session,
    "x-session-affinity": session,
    "x-opencode-project": "global",
    Accept: stream ? "text/event-stream" : "*/*",
  };
}

const MODEL_ALIASES = new Map();
for (const pair of (process.env.SHIM_MODEL_ALIASES || "").split(",")) {
  const [from, to] = pair.split("=").map((s) => s?.trim());
  if (from && to) MODEL_ALIASES.set(from, to);
}
// Callers sometimes expose the free model under a friendlier name.
for (const [from, to] of [
  ["hermes-deepseek-v4-pro", "deepseek-v4.1-flash-free"],
  ["deepseek-v4.1-flash", "deepseek-v4.1-flash-free"],
]) {
  if (!MODEL_ALIASES.has(from)) MODEL_ALIASES.set(from, to);
}

function resolveModel(model) {
  let m = String(model || "big-pickle").trim();
  if (m.startsWith("opencode/")) m = m.slice("opencode/".length);
  return MODEL_ALIASES.get(m) || m;
}

let modelCache = { at: 0, data: null };
async function listModels() {
  if (modelCache.data && Date.now() - modelCache.at < 5 * 60_000) return modelCache.data;
  try {
    const res = await tlsFetch(`${UPSTREAM}/inference/v1/models`, {
      method: "GET",
      headers: {
        Authorization: "Bearer public",
        "User-Agent": UA,
        "x-opencode-client": "cli",
      },
    }, { timeoutMs: 20_000, proxyUrl: PROXY });
    if (res.ok) {
      const body = await res.json();
      if (Array.isArray(body?.data) && body.data.length) {
        modelCache = { at: Date.now(), data: body.data };
        return body.data;
      }
    }
  } catch (error) {
    console.error("[gateway] models fetch failed:", error.message);
  }
  return FALLBACK_MODELS.map((id) => ({ id, object: "model", owned_by: "opencode" }));
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function sendError(res, status, message, type = "upstream_error") {
  sendJson(res, status, { error: { message, type, param: null, code: null } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function* sseEvents(stream) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).trim();
}

function mergeToolCall(acc, delta) {
  const index = Number.isInteger(delta.index) ? delta.index : acc.length;
  let entry = acc[index];
  if (!entry) {
    entry = { id: "", type: "function", function: { name: "", arguments: "" } };
    acc[index] = entry;
  }
  if (delta.id) entry.id = delta.id;
  if (delta.type) entry.type = delta.type;
  const fn = delta.function || {};
  if (fn.name) entry.function.name = fn.name;
  if (typeof fn.arguments === "string") entry.function.arguments += fn.arguments;
  return entry;
}

async function callUpstream(upstreamBody, session, hooks = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let upstreamRes;
  try {
    upstreamRes = await tlsFetch(`${UPSTREAM}/inference/openai/v1/chat/completions`, {
      method: "POST",
      headers: upstreamHeaders(session, true),
      body: JSON.stringify(upstreamBody),
      signal: controller.signal,
    }, { timeoutMs: TIMEOUT_MS, proxyUrl: PROXY });
  } catch (error) {
    clearTimeout(timer);
    return {
      error: {
        status: 504,
        message: error?.name === "AbortError" ? "upstream timeout" : error.message,
        type: "timeout_error",
      },
    };
  }

  if (!upstreamRes.ok) {
    clearTimeout(timer);
    const text = await upstreamRes.text().catch(() => "");
    let message = text.slice(0, 500);
    let type = "upstream_error";
    try {
      const parsed = JSON.parse(text);
      message = parsed?.error?.message || message;
      type = parsed?.error?.type || type;
    } catch { /* keep raw text */ }
    return { error: { status: upstreamRes.status, message, type } };
  }

  const out = { content: "", reasoning: "", calls: [], finish: null, usage: null };
  try {
    for await (const data of sseEvents(upstreamRes.body)) {
      if (data === "[DONE]") break;
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }
      if (event.usage) out.usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        out.content += delta.content;
        hooks.onContent?.(delta.content);
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        out.reasoning += delta.reasoning_content;
        hooks.onReasoning?.(delta.reasoning_content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const call of delta.tool_calls) mergeToolCall(out.calls, call);
      }
      if (choice.finish_reason) out.finish = choice.finish_reason;
    }
  } catch (error) {
    clearTimeout(timer);
    return { error: { status: 502, message: error.message, type: "upstream_error" } };
  }
  clearTimeout(timer);
  return out;
}

async function handleChat(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody || "{}");
  } catch {
    return sendError(res, 400, "invalid json", "invalid_request_error");
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, "messages is required", "invalid_request_error");
  }

  const model = resolveModel(body.model);
  const wantsStream = Boolean(body.stream);
  const wantUsage = Boolean(body.stream_options?.include_usage);
  const session = sessionFor(body);

  const { tools, rename, placeholderNames } = buildTools(body.tools, { full: true });
  const upstream = {
    model,
    messages: body.messages,
    stream: true,
    tools,
    prompt_cache_key: session,
  };
  if (body.temperature !== undefined) upstream.temperature = body.temperature;
  if (body.top_p !== undefined) upstream.top_p = body.top_p;
  if (body.max_tokens !== undefined) upstream.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) upstream.max_completion_tokens = body.max_completion_tokens;
  if (body.reasoning_effort !== undefined) upstream.reasoning_effort = body.reasoning_effort;
  if (body.response_format !== undefined) upstream.response_format = body.response_format;

  injectSystem(upstream);
  appendSystemNote(upstream, placeholderNote(placeholderNames));
  upstream.messages = injectReasoningPlaceholder(upstream.messages);

  const id = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "");
  const created = Math.floor(Date.now() / 1000);
  const outHeaders = {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };

  let streamStarted = false;
  const startStream = () => {
    if (streamStarted) return;
    streamStarted = true;
    res.writeHead(200, outHeaders);
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`);
  };
  const sendChunk = (delta, finish = null) => {
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
  };

  const hooks = wantsStream
    ? {
      onContent: (text) => { startStream(); sendChunk({ content: text }); },
      onReasoning: (text) => { startStream(); sendChunk({ reasoning_content: text }); },
    }
    : {};

  let result = await callUpstream(upstream, session, hooks);
  if (result.error) {
    if (streamStarted) { res.end(); return; }
    return sendError(res, result.error.status, result.error.message, result.error.type);
  }

  const clientNames = tools
    .map((t) => t.function?.name)
    .filter((name) => name && !placeholderNames.includes(name));

  const realCalls = () => result.calls.filter(
    (call) => call?.function?.name && !isPlaceholderCall(call.function.name, placeholderNames)
  );

  // The model sometimes reaches for one of the harness declarations instead of
  // the caller's tools. Those cannot run here, and dropping them silently ends
  // the turn with an empty answer — retry once with an explicit correction.
  if (!result.content && realCalls().length === 0 && result.calls.length > 0) {
    const rejected = result.calls.filter((c) => c?.function?.name);
    const correction = rejected.map((call) => ({
      role: "tool",
      tool_call_id: call.id || "call_placeholder",
      name: call.function.name,
      content:
        `Tool "${call.function.name}" is a harness placeholder and is not available here. ` +
        (clientNames.length
          ? `Use one of the client's tools instead: ${clientNames.join(", ")}.`
          : "Answer the user directly in text."),
    }));
    const retryBody = {
      ...upstream,
      messages: [
        ...upstream.messages,
        {
          role: "assistant",
          content: null,
          tool_calls: rejected.map((call, index) => ({
            id: call.id || `call_${index}`,
            type: "function",
            function: call.function,
          })),
        },
        ...correction,
      ],
    };
    const retried = await callUpstream(retryBody, session, hooks);
    if (!retried.error) {
      result = {
        ...retried,
        content: retried.content || result.content,
        reasoning: retried.reasoning || result.reasoning,
      };
    }
  }

  const calls = realCalls();
  // Still placeholder-only after the correction: never end the turn silently.
  if (!result.content && calls.length === 0 && result.calls.length > 0) {
    const names = [...new Set(result.calls.map((c) => c?.function?.name).filter(Boolean))];
    result.content =
      `[gateway] The model tried to call the harness placeholder tool(s) ${names.join(", ")}, ` +
      "which this gateway cannot execute. Provide the matching tool from your client " +
      "(for example a web_search tool) and retry.";
    result.finish = "stop";
  }
  const finishReason = calls.length ? "tool_calls" : (result.finish || "stop");

  if (!wantsStream) {
    const message = { role: "assistant", content: result.content || null };
    if (result.reasoning) message.reasoning_content = result.reasoning;
    if (calls.length) message.tool_calls = calls;
    return sendJson(res, 200, {
      id, object: "chat.completion", created, model,
      choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
      usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      system_fingerprint: "opencode-gateway-" + VERSION,
    });
  }

  startStream();
  if (calls.length) {
    sendChunk({
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: call.function,
      })),
    });
  }
  sendChunk({}, finishReason);
  if (wantUsage) {
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model,
      choices: [], usage: result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  res.on("finish", () => {
    console.log(`${req.socket.remoteAddress} ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
  });

  if (path === "/health" || path === "/healthz") {
    return sendJson(res, 200, { status: "ok", version: VERSION });
  }

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${TOKEN}` && auth !== TOKEN) {
    return sendError(res, 401, "invalid api key", "authentication_error");
  }

  if (req.method === "GET" && path === "/v1/models") {
    const data = await listModels();
    return sendJson(res, 200, { object: "list", data });
  }
  if (req.method === "GET" && path.startsWith("/v1/models/")) {
    const id = decodeURIComponent(path.slice("/v1/models/".length));
    const data = await listModels();
    const found = data.find((m) => m.id === id);
    return found
      ? sendJson(res, 200, found)
      : sendError(res, 404, `model ${id} not found`, "not_found_error");
  }

  if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/v1/completions")) {
    let raw;
    try {
      raw = await readBody(req);
    } catch (error) {
      return sendError(res, 413, error.message, "invalid_request_error");
    }
    if (path === "/v1/completions") {
      try {
        const parsed = JSON.parse(raw || "{}");
        const prompt = Array.isArray(parsed.prompt) ? parsed.prompt.join("\n") : String(parsed.prompt || "");
        parsed.messages = [{ role: "user", content: prompt }];
        delete parsed.prompt;
        raw = JSON.stringify(parsed);
      } catch {
        return sendError(res, 400, "invalid json", "invalid_request_error");
      }
    }
    return handleChat(req, res, raw);
  }

  return sendError(res, 404, "not found", "not_found_error");
});

server.listen(PORT, BIND, () => {
  console.log(`[gateway] v${VERSION} listening on ${BIND}:${PORT} upstream=${UPSTREAM} tools=${OFFICIAL_NAMES.length}`);
});
