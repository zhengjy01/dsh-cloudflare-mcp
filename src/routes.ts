/**
 * dsh-cloudflare-mcp — loopback HTTP routes for the web settings panel and
 * the OAuth callback.
 *
 * Route family: /api/dsh-cloudflare-mcp/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) except the OAuth callback, which must
 * accept the browser landing from mcp.cloudflare.com — it still requires a
 * loopback client and verifies the OAuth `state` inside the flow.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CloudflareMcpStore } from './store.ts'
import type { OAuthFlow } from './oauth.ts'
import type { McpSupervisor } from './mcp.ts'

/** Route paths. */
export const CLOUDFLARE_MCP_API = {
  status: '/api/dsh-cloudflare-mcp/status',
  oauthStart: '/api/dsh-cloudflare-mcp/oauth/start',
  oauthCallback: '/api/dsh-cloudflare-mcp/oauth/callback',
  oauthFinish: '/api/dsh-cloudflare-mcp/oauth/finish',
  oauthRefresh: '/api/dsh-cloudflare-mcp/oauth/refresh',
  test: '/api/dsh-cloudflare-mcp/test',
  clear: '/api/dsh-cloudflare-mcp/clear',
} as const

/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Strict loopback fence for the non-callback routes. */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Callback route fence: loopback client + host header, any origin (cross-site navigation from the OAuth provider is expected). */
function isLoopbackCallbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    const hostUrl = new URL(`http://${host}`)
    return hostUrl.hostname === '127.0.0.1' || hostUrl.hostname === 'localhost' || hostUrl.hostname === '[::1]'
  } catch {
    return false
  }
}

/** One JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(payload)
}

/** One HTML response (used only by the OAuth callback page). */
function writeHtml(res: ServerResponse, status: number, title: string, body: string): void {
  const html =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<title>' + title + '</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;' +
    'align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}' +
    '.card{background:#fff;border:1px solid #e2e5e9;border-radius:12px;padding:32px 40px;max-width:520px;' +
    'box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0}</style>' +
    '</head><body><div class="card"><h1>' + title + '</h1><p>' + body + '</p></div></body></html>'
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end(html)
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** Extract a string query parameter. */
function queryParam(req: IncomingMessage, name: string): string {
  try {
    const url = new URL(req.url ?? '', 'http://localhost')
    return url.searchParams.get(name) ?? ''
  } catch {
    return ''
  }
}

/** Route handler context. */
export interface RouteContext {
  store: CloudflareMcpStore
  flow: OAuthFlow
  supervisor: McpSupervisor
  /** The loopback OAuth callback URL. */
  callbackUrl: string
}

/**
 * Build every /api/dsh-cloudflare-mcp route (exact paths).
 * @param deps - store, oauth flow, MCP supervisor, callback URL.
 * @returns the route list.
 */
export function makeRoutes(deps: RouteContext) {
  const { store, flow, supervisor, callbackUrl } = deps

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  const statusView = async (): Promise<Record<string, unknown>> => {
    const view = await store.view(callbackUrl)
    return {
      ...view,
      connected: supervisor.isConnected(),
      toolCount: supervisor.toolCount(),
    }
  }

  return [
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.status,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'GET')) return
        writeJson(res, 200, await statusView())
      },
    },
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.oauthStart,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        try {
          const { authorizeUrl } = await flow.begin(callbackUrl)
          writeJson(res, 200, { ok: true, authorizeUrl, callbackUrl })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String(error instanceof Error ? error.message : error) })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.oauthCallback,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!isLoopbackCallbackRequest(req)) {
          writeHtml(res, 403, '授权失败', '回调请求来自非本机地址，已拒绝。')
          return
        }
        const code = queryParam(req, 'code')
        const state = queryParam(req, 'state')
        const error = queryParam(req, 'error')
        if (error !== '') {
          flow.abort()
          writeHtml(res, 400, '授权失败', 'Cloudflare 返回错误：' + error + '。请重试或使用手动粘贴 code 的方式。')
          return
        }
        if (code === '') {
          writeHtml(res, 400, '授权失败', '回调中没有 code 参数。')
          return
        }
        const result = await flow.complete(code, state)
        if (!result.ok) {
          writeHtml(res, 400, '授权失败', result.message)
          return
        }
        // Tokens are in the store; bring the MCP connection up.
        void supervisor.start().catch(() => {})
        writeHtml(res, 200, '授权成功', 'Cloudflare MCP 授权已完成，令牌已保存。现在可以关闭此页面，回到 DSH 设置面板或继续对话。')
      },
    },
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.oauthFinish,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { error: 'invalid JSON body' })
          return
        }
        let code = typeof body.code === 'string' ? body.code.trim() : ''
        if (code === '' && typeof body.redirectUrl === 'string') {
          try {
            code = new URL(body.redirectUrl).searchParams.get('code') ?? ''
          } catch {
            code = ''
          }
        }
        if (code === '') {
          writeJson(res, 400, { error: '缺少 code（或无法从 redirectUrl 提取 code）' })
          return
        }
        const result = await flow.complete(code, '')
        if (result.ok) {
          void supervisor.start().catch(() => {})
        }
        writeJson(res, 200, { ok: result.ok, message: result.message, view: await statusView() })
      },
    },
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.oauthRefresh,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        // The transport refreshes automatically on 401; this endpoint forces a
        // refresh so the panel can verify the refresh_token still works.
        const provider = flow.activeProvider
        if (provider === null) {
          writeJson(res, 200, { ok: false, message: '没有活动的 OAuth provider（服务重启后请先测试连接以触发刷新）。', view: await statusView() })
          return
        }
        try {
          const { auth } = await import('@modelcontextprotocol/sdk/client/auth.js')
          const result = await auth(provider, { serverUrl: 'https://mcp.cloudflare.com/mcp' })
          writeJson(res, 200, {
            ok: result === 'AUTHORIZED',
            message: result === 'AUTHORIZED' ? '令牌刷新成功。' : '刷新未完成。',
            view: await statusView(),
          })
        } catch (error) {
          writeJson(res, 200, { ok: false, message: '刷新失败：' + String(error instanceof Error ? error.message : error), view: await statusView() })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.test,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        const view = await store.view(callbackUrl)
        if (!view.authorized) {
          writeJson(res, 200, { ok: false, error: '尚未授权：请先点击「开始授权」。', view: await statusView() })
          return
        }
        try {
          if (!supervisor.isConnected()) {
            await supervisor.start()
          }
          const tools = await supervisor.listTools()
          writeJson(res, 200, { ok: true, message: `连接成功，发现 ${tools.length} 个 Cloudflare MCP 工具。`, tools, view: await statusView() })
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String(error instanceof Error ? error.message : error), view: await statusView() })
        }
      },
    },
    {
      kind: 'exact' as const,
      path: CLOUDFLARE_MCP_API.clear,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (!guard(req, res, 'POST')) return
        flow.abort()
        await supervisor.dispose()
        await store.clearAll()
        writeJson(res, 200, { ok: true, message: '已清除 Cloudflare MCP 的令牌与客户端注册。', view: await statusView() })
      },
    },
  ]
}
