#!/usr/bin/env python3
"""OpenAI-compatible gateway that drives the official `opencode` CLI.

Why this exists: OpenCode's free tier rejects non-official clients
("free tier can only be used from within OpenCode"). This shim runs the real
`opencode run` binary per request, so free-tier calls are made by the official
client, and reshapes the JSON event stream into OpenAI chat-completions JSON.

Env:
  SHIM_PORT         listen port (default 18001)
  SHIM_BIND         listen address (default 127.0.0.1, use 0.0.0.0 in Docker)
  SHIM_TOKEN        API token; if unset, read/generate SHIM_TOKEN_FILE
  SHIM_TOKEN_FILE   token file (default /data/token in image)
  SHIM_PROXY        proxy for the CLI, e.g. socks5h://user:pass@host:port
  SHIM_WORKDIR      scratch dir the CLI runs in (default /tmp/opencode-work)
  SHIM_TIMEOUT      per-request timeout seconds (default 300)
  SHIM_CONCURRENCY  max parallel CLI processes (default 1)
"""
import json
import os
import secrets
import shutil
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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


def build_prompt(messages):
    system, turns = [], []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        if isinstance(content, list):
            content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
        if role == "system":
            system.append(str(content))
        elif role == "assistant":
            turns.append(f"Assistant: {content}")
        else:
            turns.append(f"User: {content}")
    head = ("\n\n".join(system) + "\n\n") if system else ""
    return head + "\n".join(turns)


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

    def log_message(self, fmt, *args):
        print("%s %s" % (self.address_string(), fmt % args), flush=True)

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self):
        auth = self.headers.get("Authorization", "")
        return auth in ("Bearer " + TOKEN, TOKEN)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz"):
            return self._json(200, {"status": "ok"})
        if not self._authorized():
            return self._json(401, {"error": {"message": "invalid api key", "type": "auth_error"}})
        if self.path.startswith("/v1/models"):
            data = [{"id": m, "object": "model", "created": 1792860000, "owned_by": "opencode"}
                    for m in MODELS]
            return self._json(200, {"object": "list", "data": data})
        return self._json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})

    def do_POST(self):
        if not self._authorized():
            return self._json(401, {"error": {"message": "invalid api key", "type": "auth_error"}})
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": {"message": "not found", "type": "invalid_request_error"}})
        length = int(self.headers.get("Content-Length", "0"))
        try:
            req = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            return self._json(400, {"error": {"message": "invalid json", "type": "invalid_request_error"}})
        model = req.get("model") or "big-pickle"
        messages = req.get("messages") or []
        stream = bool(req.get("stream"))
        if not messages:
            return self._json(400, {"error": {"message": "messages required", "type": "invalid_request_error"}})
        prompt = build_prompt(messages)
        with SEM:
            try:
                result = run_cli(model, prompt)
            except subprocess.TimeoutExpired:
                return self._json(504, {"error": {"message": "opencode run timed out", "type": "timeout"}})
            except Exception as exc:  # noqa: BLE001
                return self._json(500, {"error": {"message": str(exc)[:300], "type": "server_error"}})
        if result["error"] and not result["text"]:
            return self._json(502, {"error": {"message": result["error"], "type": "upstream_error"}})
        cid = "chatcmpl-" + uuid.uuid4().hex[:24]
        created = int(time.time())
        usage = result["usage"] or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        if not stream:
            return self._json(200, {
                "id": cid, "object": "chat.completion", "created": created, "model": model,
                "choices": [{"index": 0, "message": {"role": "assistant", "content": result["text"]},
                             "finish_reason": "stop"}],
                "usage": usage,
            })
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()

        def chunk(delta, finish=None):
            payload = {"id": cid, "object": "chat.completion.chunk", "created": created,
                       "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(b"data: " + json.dumps(payload, ensure_ascii=False).encode() + b"\n\n")
            self.wfile.flush()

        chunk({"role": "assistant", "content": ""})
        text = result["text"]
        for i in range(0, len(text), 400):
            chunk({"content": text[i:i + 400]})
        chunk({}, "stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    print(f"[shim] listening on {BIND}:{PORT} models={len(MODELS)} proxy={'on' if PROXY else 'off'}", flush=True)
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()
