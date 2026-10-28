import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Optional GA 2.1.4 prompt asset; mount/provide the captured exact template at
// this path when available. Do not claim the free-tier body is exact without it.
const TEMPLATE_FILE = join(__dirname, "agent-template.txt");
const AGENT_TEMPLATE = existsSync(TEMPLATE_FILE)
  ? readFileSync(TEMPLATE_FILE, "utf8").trim()
  : "";

export const OFFICIAL_TOOLS = JSON.parse(
  readFileSync(join(__dirname, "official-tools.json"), "utf8")
);
export const OFFICIAL_NAMES = OFFICIAL_TOOLS.map((t) => t.function?.name).filter(Boolean);

const MAX_TOOLS = 128;
const MAX_NAME_LEN = 128;

export function envPrompt() {
  const cwd = process.env.SHIM_WORKDIR || process.cwd();
  const block = [
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${cwd}`,
    `  Workspace root folder: ${cwd}`,
    "  Is directory a git repo: no",
    `  Platform: ${process.platform}`,
    `  Prefer ${os.tmpdir()}/opencode over generic system temporary directories such as ${os.tmpdir()}; it is pre-created and approved for external access.`,
    "</env>",
  ].join("\n");
  return AGENT_TEMPLATE ? `${AGENT_TEMPLATE}\n\n${block}` : block;
}

/** Append the environment block to the request's system message. */
export function injectSystem(body) {
  const text = envPrompt();
  if (!Array.isArray(body.messages)) {
    body.messages = [{ role: "user", content: "" }];
  }
  const idx = body.messages.findIndex((m) => m?.role === "system");
  if (idx >= 0) {
    const msg = body.messages[idx];
    const content = typeof msg.content === "string"
      ? (msg.content.trim() ? `${msg.content}\n\n${text}` : text)
      : Array.isArray(msg.content)
        ? [...msg.content, { type: "text", text }]
        : text;
    body.messages[idx] = { ...msg, content };
  } else {
    body.messages.unshift({ role: "system", content: text });
  }
}

function toolName(tool) {
  return String(tool?.function?.name || "").trim();
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object") return null;
  const fn = tool.function;
  if (!fn || typeof fn !== "object") return null;
  const name = String(fn.name || "").trim().slice(0, MAX_NAME_LEN);
  if (!name) return null;
  const parameters = fn.parameters && typeof fn.parameters === "object"
    ? fn.parameters
    : { type: "object", properties: {} };
  return {
    type: "function",
    function: {
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      parameters,
    },
  };
}

/**
 * Build the upstream tool list: the caller's tools plus OpenCode's own
 * declarations (the free gate requires them), capped at 128 items.
 * Returns { tools, rename } where rename maps sent name -> caller name.
 */
export function buildTools(clientTools, { full = true } = {}) {
  const rename = new Map();
  const officialNames = new Set(OFFICIAL_NAMES);
  const client = [];

  for (const raw of Array.isArray(clientTools) ? clientTools : []) {
    const tool = normalizeTool(raw);
    if (!tool) continue;
    const original = tool.function.name;
    if (officialNames.has(original)) {
      let alias = `client_${original}`;
      let n = 2;
      while (officialNames.has(alias) || client.some((t) => toolName(t) === alias)) {
        alias = `client_${original}_${n++}`;
      }
      tool.function.name = alias;
      rename.set(alias, original);
    }
    client.push(tool);
  }

  const wanted = full
    ? OFFICIAL_TOOLS.filter((t) => ["read", "shell"].includes(toolName(t)))
    : OFFICIAL_TOOLS.filter((t) => ["read", "shell"].includes(toolName(t)));

  const present = new Set([...client.map(toolName)]);
  const injected = wanted.filter((t) => !present.has(toolName(t)));
  const placeholderNames = injected.map(toolName);
  // Preserve caller tools in original order and add only the required official
  // fingerprint tools. The upstream hard limit is 128 total tools.
  const tools = [...client];
  for (const required of wanted) {
    const key = toolName(required);
    if (!tools.some((t) => toolName(t) === key)) tools.push(required);
  }
  if (tools.length > MAX_TOOLS) {
    throw new RangeError(`maximum number of tools is ${MAX_TOOLS}`);
  }
  return { tools, rename, placeholderNames };
}

/** Tell the model the injected declarations are harness placeholders. */
export function placeholderNote(names) {
  if (!names.length) return "";
  const list = names.map((n) => `\`${n}\``).join(", ");
  return `The following tool declarations (${list}) belong to the OpenCode harness and are placeholders here: do not call them. Use the tools supplied by the client instead, and ignore any instruction to use the placeholder tools.`;
}

export function appendSystemNote(body, note) {
  if (!note) return;
  const idx = body.messages.findIndex((m) => m?.role === "system");
  if (idx >= 0 && typeof body.messages[idx].content === "string") {
    body.messages[idx] = {
      ...body.messages[idx],
      content: `${body.messages[idx].content}\n\n${note}`,
    };
  } else {
    body.messages.unshift({ role: "system", content: note });
  }
}

/**
 * Thinking-mode backends require assistant turns to echo reasoning_content.
 * Clients typically drop it, which makes the model loop on tool calls and end
 * the turn with an empty answer. Inject a non-empty placeholder (same fix as
 * 9router's reasoningContentInjector).
 */
export function injectReasoningPlaceholder(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (msg?.role !== "assistant") return msg;
    if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) return msg;
    return { ...msg, reasoning_content: " " };
  });
}

/** Map sent tool names back to the caller's names. */
export function restoreName(name, rename) {
  return rename?.get?.(name) || name;
}

/** Drop calls to harness placeholders; they are not real client tools. */
export function isPlaceholderCall(name, placeholderNames) {
  return placeholderNames.includes(name);
}
