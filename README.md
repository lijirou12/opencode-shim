# opencode-shim

把 OpenCode 的免费模型包装成 **OpenAI 兼容 API**。

原理：OpenCode 的免费额度只允许官方客户端使用（其他客户端会收到
`FreeTierError: free tier can only be used from within OpenCode`）。
这个镜像里装了官方 `opencode` 客户端，每收到一条 `/v1/chat/completions`
就真正调用一次 `opencode run --format json`，再把事件流转换成 OpenAI 格式返回。

## 能力

- `POST /v1/chat/completions`：文本对话
- `POST /v1/completions`：旧版补全接口（内部转 chat）
- `GET /v1/models`、`GET /v1/models/{id}`
- **工具调用（function calling）**：`tools` / `tool_choice` / `functions` 都支持，
  返回标准 `tool_calls` + `finish_reason: "tool_calls"`，也接受 `role: "tool"` 结果回填
- **流式**：`stream: true`，工具调用同样以 `delta.tool_calls` 下发，
  支持 `stream_options.include_usage`

工具调用是**模拟实现**：工具 schema 会写进提示词，模型按约定输出 JSON 信封，
网关再翻译成 OpenAI 的 `tool_calls`。所以它对外协议是标准的，但内部依赖模型遵守约定；
遇到模型说"没有这个工具"时网关会自动重试一次并纠正。

## 快速开始

```bash
docker run -d --name opencode-shim \
  -p 18001:18001 \
  -e SHIM_TOKEN=换成你自己的随机字符串 \
  -e SHIM_PROXY=socks5h://user:pass@proxy-host:27507 \
  --memory=1g \
  -v opencode-shim-data:/data \
  ghcr.io/OWNER/opencode-shim:latest
```

不设 `SHIM_TOKEN` 时，首次启动会生成一个 token 并写入容器内 `/data/token`：

```bash
docker exec opencode-shim cat /data/token
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SHIM_PORT` | `18001` | 监听端口 |
| `SHIM_BIND` | `0.0.0.0` | 监听地址 |
| `SHIM_TOKEN` | 空 | API token；为空则读/生成 `/data/token` |
| `SHIM_TOKEN_FILE` | `/data/token` | token 文件路径 |
| `SHIM_PROXY` | 空 | 给客户端用的代理，如 `http://user:pass@host:port`；为空则直连。**必须用 http/socks5（非 socks5h）**，Node 的 fetch 不支持 `socks5h://` |
| `SHIM_TIMEOUT` | `300` | 单次请求超时（秒） |
| `SHIM_CONCURRENCY` | `1` | 同时运行的客户端进程数，内存小就别调高 |
| `SHIM_WORKDIR` | `/tmp/opencode-work` | 客户端工作目录 |

## 调用示例

```bash
curl http://HOST:18001/v1/chat/completions \
  -H "Authorization: Bearer $SHIM_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"big-pickle","messages":[{"role":"user","content":"你好"}]}'
```

`/v1/models` 返回可用模型；`glm-5.3-flash` 这类简写会自动映射到
`glm-5.3-flash-free`。

## 注意

- **每次请求启动一个客户端进程**，所以延迟较高（十几秒起），并发能力弱。
  这是免费额度机制决定的，不是实现偷懒。
- 内存建议至少 1GB；`SHIM_CONCURRENCY=1` 时单进程约 300–500MB。
- 流式（`stream:true`）是在拿到完整结果后分块下发，不是逐 token 实时流。
- 只用于个人使用；公开暴露时务必设置强 `SHIM_TOKEN`。

## 构建

推送到 `main` 后 GitHub Actions 会自动构建 `linux/amd64` + `linux/arm64`
并推送到 GHCR。也可以本地构建：

```bash
docker build -t opencode-shim .
```
