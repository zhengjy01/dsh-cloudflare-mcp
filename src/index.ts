/**
 * dsh-cloudflare-mcp — Cloudflare MCP connection for DeepSeek Harness.
 * Host half.
 *
 * Mounts the Cloudflare MCP server tools (https://mcp.cloudflare.com/mcp)
 * under `mcp__cloudflare__*` once the official OAuth flow completes, the
 * /api/dsh-cloudflare-mcp route family the settings panel talks to, the
 * OAuth callback route, a small set of agent-facing helper tools
 * (cloudflare_mcp_*), and a system-prompt announcement. OAuth tokens live
 * in ~/.dsh/dsh-cloudflare-mcp.json (mode 0600). Everything rides official
 * npm packages (@modelcontextprotocol/sdk) — no dsh source changes.
 *
 * Auth is the MCP OAuth 2.0 flow against mcp.cloudflare.com: dynamic
 * client registration (PKCE S256), loopback callback on the GUI's own web
 * server, refresh_token grant. See src/oauth.ts.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { CloudflareMcpStore } from './store.ts'
import { OAuthFlow } from './oauth.ts'
import { createSupervisor, type McpSupervisor } from './mcp.ts'
import { makeRoutes, CLOUDFLARE_MCP_API } from './routes.ts'

/** Stable cordis plugin name. */
export const name = 'cloudflare-mcp'

/** Services required before the surfaces can mount. */
export const inject = ['tools', 'systemPrompt', 'webServer']

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 161

/** Model-facing announcement: plugin presence, capabilities, and limits. */
export const CLOUDFLARE_MCP_GUIDANCE =
  '本机已安装 dsh-cloudflare-mcp 插件（Cloudflare MCP 连接）：通过官方 OAuth 授权后，' +
  'Cloudflare 官方 MCP 服务器（mcp.cloudflare.com）的工具以 mcp__cloudflare__* 形式可用，' +
  '覆盖账户信息、Workers、Pages、DNS、R2、KV、D1、AI 等 Cloudflare API 操作。' +
  '授权流程：cloudflare_mcp_oauth_start 获取授权链接 → 用户浏览器登录 Cloudflare 并授权 → ' +
  '自动回调完成（也可把回调地址里的 code 交给 cloudflare_mcp_oauth_finish）。' +
  'cloudflare_mcp_status 查看连接状态（不回显令牌），cloudflare_mcp_test 测试连接并列出工具。' +
  '令牌存 ~/.dsh/dsh-cloudflare-mcp.json（权限 0600）。也可在 Web 设置页「Cloudflare MCP」面板中授权与测试。' +
  '用户提到「Cloudflare / MCP / Workers 部署 / 查账户」时即指本插件，请据此协作。'

/** Plugin config, read from the composition row. */
export interface Config {
  /** When true (default), a system-prompt section announces the plugin. */
  announceToAgent?: boolean
  /** Master switch for the plugin (routes, tools, prompt section). */
  enabled?: boolean
}

/**
 * Mount the Cloudflare MCP tools, helper tools, routes, and announcement.
 * @param ctx - host plugin context carrying tools/systemPrompt/webServer.
 * @param config - plugin config from the composition row.
 */
export function apply(ctx: Context, config?: Config): void {
  const announceToAgent = config?.announceToAgent !== false
  const enabled = config?.enabled !== false
  const store = new CloudflareMcpStore()
  const flow = new OAuthFlow(store)
  const callbackUrl = `http://127.0.0.1:${ctx.webServer.port}${CLOUDFLARE_MCP_API.oauthCallback}`
  const supervisor = createSupervisor(ctx, store, flow, callbackUrl)
  const context = { store, flow, supervisor, callbackUrl }

  let disposeTools: (() => void) | undefined
  let disposeRoutes: (() => void) | undefined
  let disposeSection: (() => void) | undefined
  let started = false

  const sync = (): void => {
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (disposeRoutes !== undefined) {
      disposeRoutes()
      disposeRoutes = undefined
    }
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (!enabled) return
    disposeTools = ctx.effect(
      () => {
        const disposers = buildTools(context).map((tool) => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-cloudflare-mcp: tools',
    )
    disposeRoutes = ctx.effect(
      () => {
        const disposers = makeRoutes(context).map((route) => ctx.webServer.register(route))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-cloudflare-mcp: routes',
    )
    if (announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-cloudflare-mcp',
        order: SECTION_ORDER,
        text: CLOUDFLARE_MCP_GUIDANCE,
      })
    }
  }

  sync()

  // Auto-connect when tokens already exist (e.g. after a host restart).
  void (async () => {
    if (!enabled) return
    const view = await store.view(callbackUrl)
    if (view.authorized && !started) {
      started = true
      void supervisor.start().catch(() => {})
    }
  })()

  ctx.effect(() => {
    return () => { void supervisor.dispose() }
  }, 'dsh-cloudflare-mcp: connection')
}

/** Re-export for the settings panel's route table. */
export { CLOUDFLARE_MCP_API }

/** Re-exports for host consumers and the smoke tests. */
export { CloudflareMcpStore, mask, configPath, MCP_URL, type CloudflareMcpConfigView } from './store.ts'
export { OAuthFlow, CloudflareOAuthProvider, type PendingFlow } from './oauth.ts'
export { createSupervisor, type McpSupervisor } from './mcp.ts'
export { makeRoutes } from './routes.ts'
export { defineTool }

/** Shared tool dependencies. */
export interface ToolContext {
  store: CloudflareMcpStore
  flow: OAuthFlow
  supervisor: McpSupervisor
  callbackUrl: string
}

/** Build every agent-facing cloudflare_mcp_* tool. */
function buildTools(ctx: ToolContext): ReturnType<typeof defineTool>[] {
  return [
    cloudflareMcpStatusTool(ctx),
    cloudflareMcpOAuthStartTool(ctx),
    cloudflareMcpOAuthFinishTool(ctx),
    cloudflareMcpTestTool(ctx),
    cloudflareMcpClearTool(ctx),
  ]
}

/** One text content block. */
function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

/** Status tool: connection state, token age, tool count. */
function cloudflareMcpStatusTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_status',
    description:
      '查看 dsh-cloudflare-mcp 插件状态：是否已 OAuth 授权、令牌最近更新时间、MCP 是否已连接、已注册的 Cloudflare 工具数量。不会泄露任何密钥。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          authorized: { type: 'boolean' },
          connected: { type: 'boolean' },
          toolCount: { type: 'number' },
          tokenUpdatedAt: { type: 'string' },
          mcpUrl: { type: 'string' },
          configPath: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      const view = await ctx.store.view(ctx.callbackUrl)
      const lines = [
        view.authorized ? '已授权（令牌更新于 ' + view.tokenUpdatedAt + '）' : '未授权',
        'MCP ' + (ctx.supervisor.isConnected() ? '已连接' : '未连接'),
        '已注册工具 ' + ctx.supervisor.toolCount() + ' 个',
        '端点 ' + view.mcpUrl,
        '配置路径 ' + view.configPath,
      ]
      return {
        ok: true,
        message: 'dsh-cloudflare-mcp：' + lines.join('；') + '。' + (view.authorized
          ? '可直接使用 mcp__cloudflare__* 工具。'
          : '请用 cloudflare_mcp_oauth_start 开始授权。'),
        authorized: view.authorized,
        connected: ctx.supervisor.isConnected(),
        toolCount: ctx.supervisor.toolCount(),
        tokenUpdatedAt: view.tokenUpdatedAt,
        mcpUrl: view.mcpUrl,
        configPath: view.configPath,
      }
    },
  })
}

/** OAuth start tool: begin the flow, return the browser URL. */
function cloudflareMcpOAuthStartTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_oauth_start',
    description:
      '开始 Cloudflare MCP 的 OAuth 授权流程：返回授权链接（authorizeUrl），让用户用浏览器打开并登录 Cloudflare 授权。授权完成后自动回调本机完成。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          authorizeUrl: { type: 'string' },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      try {
        const { authorizeUrl } = await ctx.flow.begin(ctx.callbackUrl)
        return {
          ok: true,
          message: '请在浏览器中打开以下链接完成 Cloudflare 授权（打开后登录并点击允许）：' + authorizeUrl,
          authorizeUrl,
        }
      } catch (error) {
        return { ok: false, message: '开始授权失败：' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** OAuth finish tool: manual code paste fallback. */
function cloudflareMcpOAuthFinishTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_oauth_finish',
    description:
      '手动完成 Cloudflare MCP 授权：把授权后浏览器地址栏里的 code 参数（或完整回调 URL）传给本工具，完成令牌交换。用于浏览器未能自动回调的情况。',
    parameters: {
      code: { type: 'string', description: '授权回调 URL 中的 code 参数值' },
      redirectUrl: { type: 'string', description: '完整的授权回调 URL（自动提取 code）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute(args: { code?: string; redirectUrl?: string }) {
      let code = typeof args.code === 'string' ? args.code.trim() : ''
      if (code === '' && typeof args.redirectUrl === 'string' && args.redirectUrl !== '') {
        try {
          code = new URL(args.redirectUrl).searchParams.get('code') ?? ''
        } catch {
          code = ''
        }
      }
      if (code === '') {
        return { ok: false, message: '缺少 code（或无法从 redirectUrl 提取 code）。' }
      }
      const result = await ctx.flow.complete(code, '')
      if (result.ok) {
        void ctx.supervisor.start().catch(() => {})
      }
      return result
    },
  })
}

/** Test tool: connect and list the Cloudflare MCP tools. */
function cloudflareMcpTestTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_test',
    description:
      '测试 Cloudflare MCP 连接：确认授权有效并列出服务器当前提供的全部工具名（如 mcp__cloudflare__* 的前身工具名）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
          tools: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      const view = await ctx.store.view(ctx.callbackUrl)
      if (!view.authorized) {
        return { ok: false, message: '尚未授权：请用 cloudflare_mcp_oauth_start 开始授权。' }
      }
      try {
        if (!ctx.supervisor.isConnected()) {
          await ctx.supervisor.start()
        }
        const tools = await ctx.supervisor.listTools()
        return {
          ok: true,
          message: '连接成功：Cloudflare MCP 提供 ' + tools.length + ' 个工具。' +
            (tools.length > 0 ? ' 示例：' + tools.slice(0, 8).join('、') : ''),
          tools,
        }
      } catch (error) {
        return { ok: false, message: '测试失败：' + String(error instanceof Error ? error.message : error) }
      }
    },
  })
}

/** Clear tool: wipe credentials and disconnect. */
function cloudflareMcpClearTool(ctx: ToolContext) {
  return defineTool({
    name: 'cloudflare_mcp_clear',
    description:
      '清除 Cloudflare MCP 的全部凭据（OAuth 令牌与客户端注册）并断开连接，MCP 工具随之注销。需要用户确认后执行。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args: unknown, value: Record<string, unknown>) => text(String(value.message ?? '')),
    },
    async execute() {
      ctx.flow.abort()
      await ctx.supervisor.dispose()
      await ctx.store.clearAll()
      return { ok: true, message: '已清除 Cloudflare MCP 的全部凭据，MCP 工具已注销。' }
    },
  })
}
