/**
 * dsh-cloudflare-mcp — MCP connection supervisor.
 *
 * Connects to https://mcp.cloudflare.com/mcp with the OAuth provider
 * (the transport auto-attaches the bearer token and auto-refreshes on
 * 401), discovers the server's tools, and registers them on `ctx.tools`
 * under deterministic server-qualified public names
 * (`mcp__cloudflare__<rawName>`, same contract as @deepseek-ai/dsh-mcp-client).
 *
 * Lifecycle: only starts when tokens exist (an unauthenticated connect
 * would otherwise spin the OAuth redirect loop). On connection loss it
 * retries with bounded exponential backoff; when the user clears
 * credentials mid-run the supervisor stops.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Context } from '@deepseek-ai/cordis'
import { MCP_URL, type CloudflareMcpStore } from './store.ts'
import type { OAuthFlow } from './oauth.ts'

/** Raw call result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown())

/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12
/** Default per-tool-call timeout (ms). */
const TOOL_CALL_TIMEOUT_MS = 60_000
/** Close-signal wait before giving up on a generation (ms). */
const GENERATION_CLOSE_TIMEOUT_MS = 5_000

/** Reconnect backoff bounds. */
const RECONNECT = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxAttempts: 10,
} as const

/** Derive the model-facing public name (mcp__cloudflare__<rawName>). */
function publicToolName(rawName: string): string {
  const joined = `mcp__cloudflare__${rawName}`
  const normalized = joined.replace(INVALID_NAME_CHARS, '_')
  if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized
  const hash = createHash('sha256').update(`cloudflare\0${rawName}`).digest('hex').slice(0, HASH_LENGTH)
  return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`
}

/** Extract readable text from an MCP content array. */
function extractText(mcpContent: unknown, toolName: string): string {
  if (!Array.isArray(mcpContent)) return `(${toolName} returned non-content output)`
  const parts: string[] = []
  for (const value of mcpContent) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      parts.push('[unsupported content type: unknown]')
      continue
    }
    const block = value as Record<string, unknown>
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'image':
        parts.push(`[image: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`)
        break
      case 'audio':
        parts.push(`[audio: ${typeof block.mimeType === 'string' ? block.mimeType : 'unknown'}, content discarded]`)
        break
      case 'resource':
      case 'resource_link':
        parts.push('[resource: content discarded]')
        break
      default:
        parts.push(`[unsupported content type: ${String(block.type)}]`)
    }
  }
  return parts.join('\n') || `(${toolName} returned no text content)`
}

/** Connection supervisor handle. */
export interface McpSupervisor {
  /** Start (or restart) the supervised connection. Only connects when tokens exist. */
  start(): Promise<void>
  /** Whether a client generation is currently connected. */
  isConnected(): boolean
  /** Number of tools currently registered from this server. */
  toolCount(): number
  /** List the MCP server's tools (live probe; requires a connected client). */
  listTools(): Promise<string[]>
  /** Stop the supervisor and unregister all tools. */
  dispose(): Promise<void>
}

/**
 * Create the supervised connection for the Cloudflare MCP server.
 * @param ctx - cordis context carrying the tools registry and logger.
 * @param store - credential store (tokens gate the connection).
 * @param flow - OAuth flow providing the transport's auth provider.
 * @param callbackUrl - the loopback OAuth callback URL.
 * @returns the supervisor handle.
 */
export function createSupervisor(
  ctx: Context,
  store: CloudflareMcpStore,
  flow: OAuthFlow,
  callbackUrl: string,
): McpSupervisor {
  const label = 'cloudflare-mcp'
  let client: Client | null = null
  let clientClosed: Promise<void> | null = null
  let disposers = new Map<string, () => void>()
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let failedAttempts = 0
  let connectedAt: number | null = null
  let disposed = false
  /** Serializes every tool sync (initial and notification re-syncs). */
  let syncChain: Promise<unknown> = Promise.resolve()

  const isCurrent = (generation: Client): boolean => !disposed && client === generation

  function enqueueSync(generation: Client): Promise<void> {
    const run = syncChain.then(async () => {
      if (!isCurrent(generation)) return
      disposers = await syncTools(generation)
    })
    syncChain = run.catch(() => {})
    return run
  }

  function syncTools(generation: Client): Promise<Map<string, () => void>> {
    return listToolsAll(generation).then((tools) => {
      const definitions = tools.map((tool) => ({
        name: publicToolName(tool.name),
        description: tool.description ?? '',
        parameters: tool.inputSchema,
        output: {
          schema: {
            type: 'object' as const,
            properties: {
              content: { type: 'array' as const, items: {} },
              structuredContent: {},
            },
            required: ['content'],
            additionalProperties: false,
          },
          render(_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> {
            const content = typeof value === 'object' && value !== null
              ? (value as Record<string, unknown>).content
              : undefined
            return [{ type: 'text', text: extractText(content, tool.name) }]
          },
        },
        execute: async (args: unknown, exec: { signal: AbortSignal }): Promise<unknown> => {
          const cleanArgs = typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
          const result = await callToolUncached(generation, tool.name, cleanArgs, exec.signal)
          if (!Array.isArray(result.content)) {
            const text = 'toolResult' in result ? JSON.stringify(result.toolResult) : '(no output)'
            if (result.isError === true) throw new Error(text)
            return { content: [{ type: 'text', text }] }
          }
          if (result.isError === true) throw new Error(extractText(result.content, tool.name))
          return { content: result.content }
        },
      }))
      for (const dispose of disposers.values()) dispose()
      const next = new Map<string, () => void>()
      for (const definition of definitions) {
        next.set(definition.name, ctx.tools.register(definition))
      }
      return next
    })
  }

  async function listToolsAll(generation: Client): Promise<Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>> {
    const tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = []
    let cursor: string | undefined
    do {
      const response = await generation.request({ method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) }, ListToolsResultSchema)
      for (const tool of response.tools) {
        tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Record<string, unknown> })
      }
      cursor = response.nextCursor
    } while (cursor !== undefined)
    return tools
  }

  async function callToolUncached(
    generation: Client,
    rawName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ content?: unknown; isError?: boolean; toolResult?: unknown }> {
    const result = await generation.request(
      { method: 'tools/call', params: { name: rawName, arguments: args } },
      RawCallToolResultSchema,
      { signal, timeout: TOOL_CALL_TIMEOUT_MS },
    )
    return result as { content?: unknown; isError?: boolean; toolResult?: unknown }
  }

  function generationDown(generation: Client): void {
    if (!isCurrent(generation)) return
    client = null
    clientClosed = null
    scheduleReconnect()
  }

  function waitForClose(closed: Promise<void>): Promise<boolean> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS)
      timeout.unref()
      closed.then(() => {
        clearTimeout(timeout)
        resolve(true)
      })
    })
  }

  function scheduleReconnect(): void {
    if (disposed) return
    if (failedAttempts >= RECONNECT.maxAttempts) {
      syncChain = syncChain.then(() => {
        for (const dispose of disposers.values()) dispose()
        disposers = new Map()
      })
      ctx.logger.error(`${label}: giving up after ${RECONNECT.maxAttempts} reconnect attempts — tools unregistered; re-authorize or restart to reconnect`)
      return
    }
    const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** failedAttempts)
    failedAttempts += 1
    ctx.logger.warn(`${label}: connection lost; retrying in ${delayMs}ms (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connectGeneration(false)
    }, delayMs)
    reconnectTimer.unref()
  }

  async function connectGeneration(startup: boolean): Promise<void> {
    if (disposed) return
    const cfg = await store.load()
    if (cfg.tokens === null || cfg.tokens.access_token === '') {
      ctx.logger.info(`${label}: no OAuth tokens — connection deferred until authorization completes`)
      return
    }
    const generation = new Client({ name: 'dsh-cloudflare-mcp', version: '0.1.0' }, { capabilities: {} })
    let resolveClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve
    })
    let attemptSettled = false
    let closeObserved = false
    client = generation
    clientClosed = closed
    generation.onclose = () => {
      closeObserved = true
      resolveClosed()
      if (attemptSettled) generationDown(generation)
    }
    generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      if (!isCurrent(generation)) return
      ctx.logger.info(`${label}: tool list changed, re-syncing`)
      try {
        await enqueueSync(generation)
      } catch (error) {
        if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`)
      }
    })
    try {
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
        authProvider: flow.getProvider(callbackUrl),
      })
      await generation.connect(transport)
      if (closeObserved) {
        attemptSettled = true
        generationDown(generation)
        return
      }
      await enqueueSync(generation)
    } catch (error) {
      if (firstAttemptError === undefined && startup) firstAttemptError = error
      if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`)
      try {
        await generation.close()
      } catch {}
      const quiesced = closeObserved || await waitForClose(closed)
      attemptSettled = true
      if (!isCurrent(generation)) return
      if (!quiesced) {
        client = null
        clientClosed = null
        ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped; restart the Host to retry`)
        return
      }
      generationDown(generation)
      return
    }
    attemptSettled = true
    if (closeObserved) {
      generationDown(generation)
      return
    }
    if (!isCurrent(generation)) return
    connectedAt = Date.now()
    if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`)
  }

  let firstAttemptError: unknown = null

  return {
    async start(): Promise<void> {
      failedAttempts = 0
      await connectGeneration(true)
      if (firstAttemptError !== null && client === null) {
        const error = firstAttemptError
        firstAttemptError = null
        throw error
      }
    },
    isConnected(): boolean {
      return client !== null
    },
    toolCount(): number {
      return disposers.size
    },
    async listTools(): Promise<string[]> {
      if (client === null) throw new Error('Cloudflare MCP 未连接。')
      const tools = await listToolsAll(client)
      return tools.map((tool) => tool.name)
    },
    async dispose(): Promise<void> {
      disposed = true
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      const current = client
      const currentClosed = clientClosed
      client = null
      clientClosed = null
      if (current !== null) {
        try {
          await current.close()
        } catch {}
        if (currentClosed !== null && !await waitForClose(currentClosed)) {
          ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal`)
        }
      }
      await syncChain
      for (const dispose of disposers.values()) dispose()
      disposers = new Map()
    },
  }
}
