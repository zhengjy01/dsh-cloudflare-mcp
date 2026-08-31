# dsh-cloudflare-mcp

DeepSeek Harness (DSH) 的 Cloudflare MCP 连接插件：官方 Cloudflare API MCP
服务器（[mcp.cloudflare.com](https://mcp.cloudflare.com/mcp)）+ 完整的
OAuth 2.0 客户端流程（动态客户端注册、PKCE S256、回调挂在 GUI 自己的
Web 服务上、refresh_token 自动续期）+ 可视化设置面板。

授权后，Cloudflare 的全部 API 工具（账户、Workers、Pages、DNS、R2、KV、
D1、AI 等）就会以 `mcp__cloudflare__*` 形式出现在会话中，遇 401 自动刷新令牌。

## 为什么自建

DSH 自带的 `@deepseek-ai/dsh-mcp-client` 只支持静态 headers，无法完成
mcp.cloudflare.com 要求的 OAuth 流程（`WWW-Authenticate: Bearer realm="OAuth"`）。
本插件基于官方 `@modelcontextprotocol/sdk` 原语自己实现了 OAuth 客户端，
连接是真实授权，而不是手动贴 token。

## 安装

```sh
# 本地开发（link）
dsh plugin --profile web add link:/path/to/dsh-cloudflare-mcp
```

bundle 补丁会自动挂上插件行，重启 Host 后生效。令牌存
`~/.dsh/dsh-cloudflare-mcp.json`（权限 0600）。

## 授权方式

两条路，都走同一个 Cloudflare OAuth 流程：

1. **设置面板**（Web GUI → 设置 → Cloudflare MCP）：点「开始授权」，
   浏览器打开 Cloudflare 授权页，授权后自动回调完成；「测试连接」列出发现的工具。
2. **对话里**：让 agent 执行 `cloudflare_mcp_oauth_start`，打开返回的
   `authorizeUrl`；或把回调地址里的 `code` 交给 `cloudflare_mcp_oauth_finish`。

## 工具

Agent 侧辅助工具：

| 工具 | 作用 |
|---|---|
| `cloudflare_mcp_status` | 授权 + 连接状态、工具数量（不泄露密钥） |
| `cloudflare_mcp_oauth_start` | 开始 OAuth 流程，返回浏览器授权链接 |
| `cloudflare_mcp_oauth_finish` | 手动粘贴 code 的兜底方式 |
| `cloudflare_mcp_test` | 连接并列出 MCP 服务器全部工具 |
| `cloudflare_mcp_clear` | 清除凭据并断开 |

另有 MCP 服务器自身的工具，名为 `mcp__cloudflare__*`。

## API 路由

全部仅限本机回环（127.0.0.1），OAuth 回调除外（需接受 mcp.cloudflare.com
的跨站跳转，但仍校验 OAuth state）：

- `GET  /api/dsh-cloudflare-mcp/status`
- `POST /api/dsh-cloudflare-mcp/oauth/start`
- `GET  /api/dsh-cloudflare-mcp/oauth/callback`（浏览器落地页）
- `POST /api/dsh-cloudflare-mcp/oauth/finish`
- `POST /api/dsh-cloudflare-mcp/oauth/refresh`
- `POST /api/dsh-cloudflare-mcp/test`
- `POST /api/dsh-cloudflare-mcp/clear`

## 开发

```bash
pnpm install
npm run typecheck
npm run test                  # 离线 store/provider 冒烟
DSH_CLOUDFLARE_MCP_LIVE=1 npm run test   # 对 mcp.cloudflare.com 的真实 OAuth 第一阶段
npm run build                 # tsc 声明 + tsdown（lib/ + lib/client.js）
```

## License

MIT
