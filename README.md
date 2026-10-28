# opencode-gateway

把 OpenCode 免费模型包装成 **OpenAI 兼容 API**，直连 `opencode.ai` 的推理接口，
**不再为每个请求启动 `opencode` CLI 子进程**。

## 原理

免费额度只对 OpenCode 自己的客户端开放，上游会检查请求指纹。网关在请求内直接补齐：

- **端点**：chat 走 `/inference/openai/v1/chat/completions`，模型列表走 `/inference/v1/models`
- **会话**：现造 `ses_` + 12 位十六进制（当前时间编码）+ 14 位 base62，
  并同时写入 `x-opencode-session`、`x-opencode-session-id`、`x-session-id`、
  `x-session-affinity` 和 body 的 `prompt_cache_key`（五处一致）
- **工具**：注入 OpenCode 官方工具声明（`src/official-tools.json`），
  客户端工具保留；总数压在上游硬上限 128 项内
- **系统提示**：追加 OpenCode 的 `<env>` 环境块；如放入 `src/agent-template.txt`
  则一并前置完整 agent 模板
- **传输**：通过 `wreq-js` 复刻 OpenCode/Bun 的 TLS ClientHello（原生 fetch 会被 429）

工具调用是**原生透传**：上游按 OpenAI 格式返回 `tool_calls`，网关直接转发，
不再靠提示词模拟 JSON 信封。

## 接口

- `POST /v1/chat/completions`：支持 `stream`、`tools`、`tool_choice`、`reasoning_effort`
- `POST /v1/completions`：旧版补全，内部转 chat
- `GET /v1/models`、`GET /v1/models/{id}`
- `GET /health`

## 快速开始

```bash
docker run -d --name opencode-gateway \
  -p 18001:18001 \
  -e SHIM_TOKEN=换成你自己的随机字符串 \
  --memory=512m \
  ghcr.io/lijirou12/opencode-shim:latest
```

或 `docker compose up -d`（见 `docker-compose.yml`）。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SHIM_PORT` | `18001` | 监听端口 |
| `SHIM_BIND` | `0.0.0.0` | 监听地址 |
| `SHIM_TOKEN` | 必填 | 客户端 Bearer token；不设则拒绝启动 |
| `SHIM_UPSTREAM` | `https://opencode.ai` | 上游地址 |
| `SHIM_PROXY` | 空 | 出口代理，如 `http://user:pass@host:port` 或 `socks5://...` |
| `SHIM_TIMEOUT` | `300` | 单次请求超时（秒） |
| `SHIM_UA` | `opencode/latest/2.0.26/cli` | 上游 User-Agent |
| `SHIM_SESSION_TTL_MS` | `600000` | 同一会话复用 id 的时长（毫秒） |

## 调用示例

```bash
curl http://HOST:18001/v1/chat/completions \
  -H "Authorization: Bearer $SHIM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash-free","messages":[{"role":"user","content":"你好"}]}'
```

工具调用示例：

```json
{
  "model": "deepseek-v4.1-flash-free",
  "messages": [{"role": "user", "content": "东京天气怎么样？"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "Get current weather for a city",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}
    }
  }],
  "tool_choice": "required"
}
```

返回标准 `tool_calls` + `finish_reason: "tool_calls"`；把工具结果以 `role: "tool"`
回填后继续对话即可。

## 注意

- 免费额度按上游策略计费，可能随时返回 `429 FreeUsageLimitError`，这不是网关故障。
- 会话 id 的时间戳必须是当前时间，网关会定期刷新，不要长期复用同一个 id。
- 上游偶发要求完整 agent 模板：把抓到的模板写入 `src/agent-template.txt` 后重新构建即可。
- 只用于个人使用；公网暴露时务必设置强 `SHIM_TOKEN`。

## 构建

推送到 `main` 后 GitHub Actions 自动构建 `linux/amd64` + `linux/arm64` 并推送到 GHCR。
