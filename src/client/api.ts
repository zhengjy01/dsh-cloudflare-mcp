/**
 * Browser-side API client for the /api/dsh-cloudflare-mcp route family. The
 * only data access path the settings panel uses — plain fetch, same origin.
 */

/** Public status view (mirrors the host contract). */
export interface CloudflareMcpStatusView {
  configured: boolean
  authorized: boolean
  tokenUpdatedAt: string
  clientIdMasked: string
  callbackUrl: string
  mcpUrl: string
  configPath: string
  connected: boolean
  toolCount: number
}

/** Error carrying the route's JSON error message. */
export class CloudflareMcpApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CloudflareMcpApiError'
  }
}

/** Parse a JSON response or throw a CloudflareMcpApiError. */
async function readJson<T>(response: Response): Promise<T> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CloudflareMcpApiError(`HTTP ${response.status}: invalid JSON response`)
  }
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`
    throw new CloudflareMcpApiError(message)
  }
  return body as T
}

/** Plain fetch helper with an error wrapper. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new CloudflareMcpApiError('网络请求失败: ' + String(error instanceof Error ? error.message : error))
  }
  return readJson<T>(response)
}

/** The Cloudflare MCP panel API. */
export class CloudflareMcpApi {
  async status(): Promise<CloudflareMcpStatusView> {
    return request<CloudflareMcpStatusView>('/api/dsh-cloudflare-mcp/status')
  }

  async oauthStart(): Promise<{ ok: boolean; authorizeUrl?: string; error?: string }> {
    return request('/api/dsh-cloudflare-mcp/oauth/start', { method: 'POST' })
  }

  async oauthFinish(code: string, redirectUrl: string): Promise<{ ok: boolean; message: string; view: CloudflareMcpStatusView }> {
    return request('/api/dsh-cloudflare-mcp/oauth/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirectUrl }),
    })
  }

  async oauthRefresh(): Promise<{ ok: boolean; message: string; view: CloudflareMcpStatusView }> {
    return request('/api/dsh-cloudflare-mcp/oauth/refresh', { method: 'POST' })
  }

  async test(): Promise<{ ok: boolean; message?: string; error?: string; tools?: string[]; view: CloudflareMcpStatusView }> {
    return request('/api/dsh-cloudflare-mcp/test', { method: 'POST' })
  }

  async clear(): Promise<{ ok: boolean; message: string; view: CloudflareMcpStatusView }> {
    return request('/api/dsh-cloudflare-mcp/clear', { method: 'POST' })
  }
}
