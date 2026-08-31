# dsh-cloudflare-mcp

Cloudflare MCP connection for DeepSeek Harness (DSH): the official
Cloudflare API MCP server ([mcp.cloudflare.com](https://mcp.cloudflare.com/mcp))
with the full OAuth 2.0 client dance — dynamic client registration, PKCE
S256, loopback callback on the GUI's own web server, refresh-token grant —
plus a web settings panel.

Once authorized, every Cloudflare API tool (accounts, Workers, Pages, DNS,
R2, KV, D1, AI, …) becomes available in agent sessions as
`mcp__cloudflare__*`, auto-refreshing its token on 401.

## Why this plugin

DSH's built-in `@deepseek-ai/dsh-mcp-client` supports static headers only —
it cannot complete the OAuth flow that `mcp.cloudflare.com` requires
(`WWW-Authenticate: Bearer realm="OAuth"`). This plugin implements the
OAuth client itself on the official `@modelcontextprotocol/sdk` primitives,
so the connection is genuinely authenticated, not token-pasted.

## Install

```sh
# local development (link)
dsh plugin --profile web add link:/path/to/dsh-cloudflare-mcp
```

The bundle patch mounts the plugin row automatically; a Host restart is
needed for the layer to compose. Tokens live in
`~/.dsh/dsh-cloudflare-mcp.json` (mode 0600).

## Authorize

Two ways, both starting the same OAuth flow against Cloudflare:

1. **Settings panel** (Web GUI → 设置 → Cloudflare MCP): click 开始授权,
   the browser opens Cloudflare's consent page, and the loopback callback
   completes automatically. 测试连接 lists the discovered tools.
2. **Chat**: ask the agent to run `cloudflare_mcp_oauth_start`, open the
   returned `authorizeUrl`, or paste the callback `code` back into
   `cloudflare_mcp_oauth_finish`.

## Tools

Agent-facing helpers (mounted on `ctx.tools`):

| tool | what it does |
|---|---|
| `cloudflare_mcp_status` | authorization + connection state, tool count (no secrets) |
| `cloudflare_mcp_oauth_start` | begin the OAuth flow, return the browser URL |
| `cloudflare_mcp_oauth_finish` | manual code-paste fallback |
| `cloudflare_mcp_test` | connect and list the MCP server's tools |
| `cloudflare_mcp_clear` | wipe credentials and disconnect |

Plus the MCP server's own tools as `mcp__cloudflare__*`.

## API routes

All loopback-only (`127.0.0.1`), except the OAuth callback which accepts
the cross-site landing from `mcp.cloudflare.com` while still verifying the
OAuth `state`:

- `GET  /api/dsh-cloudflare-mcp/status`
- `POST /api/dsh-cloudflare-mcp/oauth/start`
- `GET  /api/dsh-cloudflare-mcp/oauth/callback` (browser landing)
- `POST /api/dsh-cloudflare-mcp/oauth/finish`
- `POST /api/dsh-cloudflare-mcp/oauth/refresh`
- `POST /api/dsh-cloudflare-mcp/test`
- `POST /api/dsh-cloudflare-mcp/clear`

## Development

```bash
pnpm install
npm run typecheck
npm run test                  # offline store/provider smoke
DSH_CLOUDFLARE_MCP_LIVE=1 npm run test   # live OAuth phase-1 against mcp.cloudflare.com
npm run build                 # tsc declarations + tsdown (lib/ + lib/client.js)
```

## License

MIT
