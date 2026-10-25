#!/usr/bin/env python3
"""OpenAI-compatible gateway backed by the official `opencode` CLI.

Design goal: from the outside this behaves like a normal OpenAI model —
chat completions, streaming, and function/tool calling — while the actual
inference is performed by the official `opencode` client (the only client
OpenCode's free tier accepts).

Tool calling is emulated: tool schemas are injected into the prompt and the
model is asked to answer with a JSON envelope, which we translate back into
OpenAI `tool_calls`. Tool results are fed back in as ordinary turns.

Env:
  SHIM_PORT         listen port (default 18001)
  SHIM_BIND         listen address (default 127.0.0.1)
  SHIM_TOKEN        API token; else read/generate SHIM_TOKEN_FILE
  SHIM_TOKEN_FILE   token file (default /data/token)
  SHIM_PROXY        proxy for the CLI, e.g. socks5h://user:pass@host:port
  SHIM_WORKDIR      scratch dir for the CLI (default /tmp/opencode-work)
  SHIM_TIMEOUT      per-request timeout seconds (default 300)
  SHIM_CONCURRENCY  max parallel CLI processes (default 1)
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2.0.0"
PORT = int(os.environ.get("SHIM_PORT", "18001"))
BIND = os.environ.get("SHIM_BIND", "127.0.0.1")
TOKEN_FILE = os.environ.get("SHIM_TOKEN_FILE", "/data/token")


def resolve_token():
    token = os.environ.get("SHIM_TOKEN", "").strip()
    if token:
        return token
    try:
        with open(TOKEN_FILE) as fh:
            saved = fh.read().strip()
        if saved:
            return saved
    except FileNotFoundError:
        pass
    token = secrets.token_urlsafe(24)
    try:
        os.makedirs(os.path.dirname(TOKEN_FILE) or ".", exist_ok=True)
        with open(TOKEN_FILE, "w") as fh:
            fh.write(token + "\n")
        os.chmod(TOKEN_FILE, 0o600)
        print(f"[shim] generated token at {TOKEN_FILE}", flush=True)
    except OSError as exc:
        print(f"[shim] token file not writable ({exc}); using in-memory token", flush=True)
    return token


TOKEN = resolve_token()
OPENCODE = os.environ.get("SHIM_OPENCODE") or shutil.which("opencode") or "/usr/local/bin/opencode"
PROXY = os.environ.get("SHIM_PROXY", "")
WORKDIR = os.environ.get("SHIM_WORKDIR", "/tmp/opencode-work")
TIMEOUT = int(os.environ.get("SHIM_TIMEOUT", "300"))
MODELS = [
    "big-pickle", "beam-free", "flint-40b-free", "mimo-v2.6-flash-free",
    "nemotron-3.5-super-vl-free", "nemotron-3.5-lightning-free", "nemotron-3-ultra-free",
    "deepseek-v4.1-flash-free", "glm-5.3-flash-free",
]
ALIASES = {m[:-5]: m for m in MODELS if m.endswith("-free")}
SEM = threading.Semaphore(int(os.environ.get("SHIM_CONCURRENCY", "1")))
os.makedirs(WORKDIR, exist_ok=True)

TOOL_PROTOCOL = """\
## Tool calling protocol
You can call the tools listed below. When you need a tool, reply with ONLY one
JSON object and nothing else (no prose, no markdown fences):

{"tool_calls":[{"name":"<tool name>","arguments":{<arguments>}}]}

Rules:
- Call only the tools listed. Never invent tool names.
- "arguments" must be a JSON object matching the tool's parameter schema.
- Multiple independent calls may go in the same "tool_calls" array.
- If no tool is needed, answer normally in plain text without JSON.
- After tool results arrive, use them to answer the user's request.

Available tools (JSON schema):
%s
"""


def _content_text(content):
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") in ("text", "input_text") and item.get("text"):
                    parts.append(item["text"])
                elif item.get("type") == "image_url":
                    parts.append("[image omitted]")
        return "\n".join(parts)
    return "" if content is None else str(content)


def build_prompt(messages, tools=None):
    """Flatten an OpenAI message list into one prompt for the CLI."""
    system, turns = [], []
    if tools:
        system.append(TOOL_PROTOCOL % json.dumps(tools, ensure_ascii=False))
    for msg in messages:
        role = msg.get("role", "user")
        text = _content_text(msg.get("content"))
        if role in ("system", "developer"):
            system.append(text)
        elif role == "assistant":
            calls = msg.get("tool_calls") or []
            if calls:
                rendered = []
                for call in calls:
                    fn = call.get("function") or {}
                    args = fn.get("arguments")
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            pass
                    rendered.append({"name": fn.get("name"), "arguments": args})
                turns.append("Assistant called tools: " + json.dumps({"tool_calls": rendered}, ensure_ascii=False))
            if text:
                turns.append(f"Assistant: {text}")
        elif role == "tool":
            name = msg.get("name") or msg.get("tool_call_id") or "tool"
            turns.append(f"Tool result ({name}): {text}")
        else:
            turns.append(f"User: {text}")
    head = ("\n\n".join(s for s in system if s) + "\n\n") if any(system) else ""
    return head + "\n".join(turns)


def _strip_fences(text):
    text = text.strip()
    match = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.S)
    return match.group(1).strip() if match else text


def parse_tool_calls(text):
    """Return (calls, remaining_text). calls is a list of OpenAI tool_calls."""
    candidate = _strip_fences(text)
    payloads = []
    try:
        payloads.append(json.loads(candidate))
    except json.JSONDecodeError:
        for blob in re.findall(r"\{.*?\}", candidate, re.S):
            try:
                payloads.append(json.loads(blob))
            except json.JSONDecodeError:
                continue
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        raw = payload.get("tool_calls") or payload.get("toolCalls")
        if raw is None and payload.get("name") and "arguments" in payload:
            raw = [payload]
        if not isinstance(raw, list) or not raw:
            continue
        calls = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("name") or (item.get("function") or {}).get("name")
            args = item.get("arguments", (item.get("function") or {}).get("arguments", {}))
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {"raw": args}
            if not name:
                continue
            calls.append({
                "id": "call_" + uuid.uuid4().hex[:24],
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
            })
        if calls:
            return calls, ""
    return [], text


def run_cli(model, prompt):
    env = dict(os.environ)
    if PROXY:
        for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "all_proxy"):
            env[key] = PROXY
        env.pop("NO_PROXY", None)
        env.pop("no_proxy", None)
    bare = model.split("/")[-1]
    bare = ALIASES.get(bare, bare)
    cmd = [OPENCODE, "run", "--format", "json", "--model", "opencode/" + bare, prompt]
    started = time.time()
    proc = subprocess.run(cmd, cwd=WORKDIR, env=env, capture_output=True, text=True, timeout=TIMEOUT)
    texts, usage, err = [], {}, None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        part = event.get("part") or {}
        if event.get("type") == "text" and part.get("text"):
            texts.append(part["text"])
        elif event.get("type") == "step_finish" and isinstance(part.get("tokens"), dict):
            tok = part["tokens"]
            usage = {
                "prompt_tokens": tok.get("input", 0),
                "completion_tokens": tok.get("output", 0),
                "total_tokens": tok.get("total", 0),
            }
        elif event.get("type") == "error":
            err = json.dumps(event.get("error") or event)[:400]
    if not texts and err is None:
        err = (proc.stderr or proc.stdout or "empty output")[-400:]
    return {"text": "".join(texts).strip(), "usage": usage, "error": err,
            "elapsed": round(time.time() - started, 2)}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opencode-shim/" + VERSION

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code, message, etype="invalid_request_error", param=None):
        self._json(code, {"error": {"message": message, "type": etype, "param": param, "code": None}})

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        return auth in ("Bearer " + TOKEN, TOKEN)

    def do_GET(self):
        path = self.path.split("?")[0].rstrip("/")
        if path in ("/health", "/healthz"):
            return self._json(200, {"status": "ok", "version": VERSION})
        if not self._authorized():
            return self._error(401, "invalid api key", "authentication_error")
        if path == "/v1/models":
            data = [{"id": m, "object": "model", "created": 1792860000, "owned_by": "opencode"} for m in MODELS]
            return self._json(200, {"object": "list", "data": data})
        if path.startswith("/v1/models/"):
            model = path.rsplit("/", 1)[-1]
            if model in MODELS or model in ALIASES:
                return self._json(200, {"id": model, "object": "model", "created": 1792860000, "owned_by": "opencode"})
            return self._error(404, f"model {model} not found", "not_found_error")
        return self._error(404, "not found", "not_found_error")

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if not self._authorized():
            return self._error(401, "invalid api key", "authentication_error")
        if path not in ("/v1/chat/completions", "/v1/completions"):
            return self._error(404, "not found", "not_found_error")
        length = int(self.headers.get("Content-Length", "0"))
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._error(400, "invalid json")
        if path == "/v1/completions":
            prompt_text = req.get("prompt") or ""
            if isinstance(prompt_text, list):
                prompt_text = "\n".join(str(p) for p in prompt_text)
            req["messages"] = [{"role": "user", "content": prompt_text}]
        model = req.get("model") or "big-pickle"
        messages = req.get("messages") or []
        tools = req.get("tools") or None
        if req.get("functions"):
            tools = [{"type": "function", "function": f} for f in req["functions"]]
        stream = bool(req.get("stream"))
        want_usage = bool((req.get("stream_options") or {}).get("include_usage"))
        if not messages:
            return self._error(400, "messages is required", param="messages")
        if tools:
            tools = [t for t in tools if isinstance(t, dict)]
            for t in tools:
                if t.get("type") == "function" and isinstance(t.get("function"), dict):
                    t["function"].pop("strict", None)
        prompt = build_prompt(messages, tools)
        with SEM:
            try:
                result = run_cli(model, prompt)
                if tools:
                    calls, text = parse_tool_calls(result["text"])
                    if not calls and re.search(r"(no|not|没有|无法|不可)[^\n]{0,30}(tool|工具)", text, re.I):
                        nudge = prompt + (
                            "\n\nThe tools listed above ARE available in this environment. "
                            "You must call the matching tool now: reply with ONLY the JSON object "
                            '{"tool_calls":[{"name":"...","arguments":{...}}]} and no other text.'
                        )
                        result = run_cli(model, nudge)
            except subprocess.TimeoutExpired:
                return self._error(504, "upstream timeout", "timeout_error")
            except Exception as exc:  # noqa: BLE001
                return self._error(500, str(exc)[:300], "server_error")
        if result["error"] and not result["text"]:
            return self._error(502, result["error"], "upstream_error")
        calls, text = parse_tool_calls(result["text"]) if tools else ([], result["text"])
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())
        usage = result["usage"] or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        message = {"role": "assistant", "content": text or None}
        if calls:
            message["tool_calls"] = calls
        finish = "tool_calls" if calls else "stop"
        if not stream:
            return self._json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": message, "finish_reason": finish, "logprobs": None}],
                "usage": usage, "system_fingerprint": "opencode-shim-" + VERSION,
            })
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def send(obj):
            self.wfile.write(b"data: " + json.dumps(obj, ensure_ascii=False).encode() + b"\n\n")
            self.wfile.flush()

        def chunk(delta, finish=None):
            send({"id": cid, "object": "chat.completion.chunk", "created": created,
                  "model": model, "system_fingerprint": "opencode-shim-" + VERSION,
                  "choices": [{"index": 0, "delta": delta, "finish_reason": finish, "logprobs": None}]})

        chunk({"role": "assistant", "content": ""})
        if text:
            for i in range(0, len(text), 200):
                chunk({"content": text[i:i + 200]})
        if calls:
            chunk({"tool_calls": [{
                "index": i, "id": c["id"], "type": "function",
                "function": {"name": c["function"]["name"], "arguments": c["function"]["arguments"]},
            } for i, c in enumerate(calls)]})
        chunk({}, finish)
        if want_usage:
            send({"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                  "choices": [], "usage": usage})
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    print(f"[shim] v{VERSION} listening on {BIND}:{PORT} models={len(MODELS)} "
          f"proxy={'on' if PROXY else 'off'} tools=on", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
