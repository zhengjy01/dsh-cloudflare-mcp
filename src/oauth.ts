/**
 * dsh-cloudflare-mcp — OAuth 2.0 flow against mcp.cloudflare.com.
 *
 * The remote Cloudflare MCP server requires OAuth (WWW-Authenticate:
 * Bearer realm="OAuth", RFC 9728 protected-resource metadata at
 * https://mcp.cloudflare.com/.well-known/oauth-protected-resource/mcp).
 * This module implements the full MCP OAuth client dance on top of the
 * official @modelcontextprotocol/sdk primitives:
 *
 *   1. `auth()` phase 1: RFC 9728 discovery, dynamic client registration
 *      (https://mcp.cloudflare.com/register), PKCE S256 authorization URL;
 *      the URL is captured by our provider and returned to the caller
 *      (settings panel / agent tool) for the browser to open.
 *   2. Browser lands on the loopback callback route
 *      (/api/dsh-cloudflare-mcp/oauth/callback on the GUI's own server);
 *      the `state` is verified against the pending flow.
 *   3. `auth()` phase 2 with the authorization code exchanges it for
 *      tokens (refresh_token grant supported), which are persisted in
 *      ~/.dsh/dsh-cloudflare-mcp.json (mode 0600).
 *
 * The same provider object is handed to the MCP Client's transport, so
 * later 401s auto-refresh through it without user interaction.
 */

import { randomUUID } from 'node:crypto'
import {
  auth,
  type AuthResult,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { MCP_URL, type CloudflareMcpStore } from './store.ts'

/** How long a pending authorization flow stays valid (ms). */
export const PENDING_FLOW_TTL_MS = 10 * 60 * 1000

/** How long `begin()` waits for the authorization URL to materialize (ms). */
export const AUTHORIZE_URL_TIMEOUT_MS = 30 * 1000

/** One in-flight authorization flow (single-slot; concurrency rejected). */
export interface PendingFlow {
  state: string
  provider: CloudflareOAuthProvider
  /** Resolves with the authorization URL once redirectToAuthorization fires. */
  authorizeUrlPromise: Promise<string>
  resolveAuthorizeUrl: (url: string) => void
  rejectAuthorizeUrl: (error: unknown) => void
  /** Set when the browser callback (or manual code) arrives. */
  code: string | null
  /** Timestamp of begin(), for TTL eviction. */
  startedAt: number
}

/**
 * OAuth client provider backed by the credential store. Implements the MCP
 * SDK's OAuthClientProvider contract: persisted client registration + tokens,
 * memory-held PKCE verifier, and a captured authorization URL for the GUI.
 */
export class CloudflareOAuthProvider implements OAuthClientProvider {
  private pending: PendingFlow | null = null
  private codeVerifierValue: string | null = null

  constructor(
    private readonly store: CloudflareMcpStore,
    private readonly callbackUrl: string,
  ) {}

  /** The loopback callback URL (registered on the GUI's own web server). */
  get redirectUrl(): string {
    return this.callbackUrl
  }

  /** Client metadata for dynamic registration (public client + PKCE). */
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'dsh-cloudflare-mcp',
      redirect_uris: [this.callbackUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }
  }

  /**
   * Flow-bound state (verified on the callback).
   *
   * The MCP SDK builds the authorize URL by calling this method itself; if it
   * returned a fresh UUID every time, the URL's `state` would differ from the
   * one `begin()` recorded in the pending flow, and the callback's state could
   * never match (the "state 校验未通过" failure). Return the active pending
   * flow's state so the authorize request reuses the exact value the pending
   * flow will verify.
   */
  async state(): Promise<string> {
    const pending = this.pending
    if (pending !== null) return pending.state
    return randomUUID()
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const cfg = await this.store.load()
    return cfg.clientInformation ?? undefined
  }

  async saveClientInformation(information: OAuthClientInformationMixed): Promise<void> {
    const cfg = await this.store.load()
    cfg.clientInformation = information as unknown as NonNullable<CloudflareMcpStore['config']>['clientInformation']
    await this.store.save(cfg)
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const cfg = await this.store.load()
    if (cfg.tokens === null) return undefined
    const tokens: OAuthTokens = { access_token: cfg.tokens.access_token, token_type: cfg.tokens.token_type ?? 'Bearer' }
    if (cfg.tokens.refresh_token !== undefined) tokens.refresh_token = cfg.tokens.refresh_token
    if (cfg.tokens.scope !== undefined) tokens.scope = cfg.tokens.scope
    return tokens
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const cfg = await this.store.load()
    cfg.tokens = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined,
      scope: tokens.scope,
      token_type: tokens.token_type ?? 'Bearer',
    }
    cfg.tokenUpdatedAt = new Date().toISOString()
    await this.store.save(cfg)
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    const cfg = await this.store.load()
    cfg.discoveryState = state as unknown as Record<string, unknown>
    await this.store.save(cfg)
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    const cfg = await this.store.load()
    return cfg.discoveryState as unknown as OAuthDiscoveryState | undefined
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') {
      await this.store.clearAll()
    } else if (scope === 'client') {
      await this.store.clearClientInformation()
    } else if (scope === 'tokens') {
      await this.store.clearTokens()
    } else if (scope === 'verifier') {
      this.codeVerifierValue = null
    } else if (scope === 'discovery') {
      const cfg = await this.store.load()
      cfg.discoveryState = null
      await this.store.save(cfg)
    }
  }

  // ---- PKCE verifier (memory-held per flow) ----

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier
  }

  async codeVerifier(): Promise<string> {
    if (this.codeVerifierValue === null) throw new Error('OAuth flow: missing PKCE code verifier (flow may have expired)')
    return this.codeVerifierValue
  }

  // ---- Authorization URL capture (GUI-driven browser opening) ----

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    const pending = this.pending
    if (pending !== null) {
      pending.resolveAuthorizeUrl(authorizationUrl.toString())
    }
    // The GUI opens the URL; nothing to navigate from the host process.
  }

  /** Wait for the pending flow's authorization URL (bounded). */
  waitForAuthorizationUrl(timeoutMs: number): Promise<string> {
    const pending = this.pending
    if (pending === null) return Promise.reject(new Error('OAuth flow: no pending authorization'))
    return Promise.race([
      pending.authorizeUrlPromise,
      new Promise<string>((_, reject) => {
        setTimeout(() => reject(new Error('OAuth flow: authorization URL timed out')), timeoutMs).unref()
      }),
    ])
  }

  /** Register the pending flow slot (rejects when one is already active). */
  beginPending(state: string): PendingFlow {
    if (this.pending !== null && Date.now() - this.pending.startedAt < PENDING_FLOW_TTL_MS) {
      throw new Error('已有一个待完成的 Cloudflare 授权流程，请先完成或等待它过期。')
    }
    let resolveAuthorizeUrl!: (url: string) => void
    let rejectAuthorizeUrl!: (error: unknown) => void
    const authorizeUrlPromise = new Promise<string>((resolve, reject) => {
      resolveAuthorizeUrl = resolve
      rejectAuthorizeUrl = reject
    })
    const pending: PendingFlow = {
      state,
      provider: this,
      authorizeUrlPromise,
      resolveAuthorizeUrl,
      rejectAuthorizeUrl,
      code: null,
      startedAt: Date.now(),
    }
    this.pending = pending
    this.codeVerifierValue = null
    return pending
  }

  /** The active pending flow (or null). */
  get pendingFlow(): PendingFlow | null {
    const pending = this.pending
    if (pending === null) return null
    if (Date.now() - pending.startedAt > PENDING_FLOW_TTL_MS) {
      this.pending = null
      return null
    }
    return pending
  }

  /** Settle a pending flow (call after the callback or manual code arrives). */
  settlePending(state: string, code: string): PendingFlow | null {
    const pending = this.pendingFlow
    if (pending === null || pending.state !== state) return null
    pending.code = code
    this.pending = null
    return pending
  }

  /** Abort any pending flow (rejects a waiting begin() with an error). */
  settlePendingAbort(): void {
    const pending = this.pending
    this.pending = null
    this.codeVerifierValue = null
    if (pending !== null) {
      pending.rejectAuthorizeUrl(new Error('授权流程已被取消。'))
    }
  }
}

/**
 * OAuth orchestration shared by the routes and the agent tools.
 * Phase 1 (`begin`) starts discovery/registration and returns the
 * authorization URL; phase 2 (`complete`) exchanges the code. The provider
 * instance is created once per callback URL and reused across flows: it
 * reads/writes tokens through the store, so the MCP transport keeps working
 * (and auto-refreshing) between authorizations.
 */
export class OAuthFlow {
  private provider: CloudflareOAuthProvider | null = null

  constructor(private readonly store: CloudflareMcpStore) {}

  /** The provider used by the MCP transport (created lazily). */
  get activeProvider(): CloudflareOAuthProvider | null {
    return this.provider
  }

  /** Get (creating if needed) the provider bound to this callback URL. */
  getProvider(callbackUrl: string): CloudflareOAuthProvider {
    if (this.provider === null) {
      this.provider = new CloudflareOAuthProvider(this.store, callbackUrl)
    }
    return this.provider
  }

  /**
   * Start an authorization: fresh dynamic client registration (the callback
   * URL is fixed per host run, but re-registering is cheap and always
   * consistent), then the discovery + authorize-URL dance. Returns the URL
   * for the browser once it exists.
   */
  async begin(callbackUrl: string): Promise<{ authorizeUrl: string; state: string }> {
    // Re-register with the current callback URL every time (a host restart
    // may have changed the port; stale redirect_uris would fail authorize).
    await this.store.clearClientInformation()

    const provider = this.getProvider(callbackUrl)

    // Allow restarting an authorization even when a prior pending flow is
    // still in the TTL window (e.g. the user closed the authorize page and
    // clicks 开始授权 again). Aborting the stale slot is a no-op once its
    // authorize URL was already captured, so the new flow always wins.
    provider.settlePendingAbort()

    const state = await provider.state()
    const pending = provider.beginPending(state)

    // Phase 1 runs in the background: discovery → DCR → PKCE → capture URL.
    const run = auth(provider, { serverUrl: MCP_URL })
    run.catch((error) => {
      pending.rejectAuthorizeUrl(error)
    })

    try {
      const authorizeUrl = await provider.waitForAuthorizationUrl(AUTHORIZE_URL_TIMEOUT_MS)
      return { authorizeUrl, state }
    } catch (error) {
      throw error
    }
  }

  /**
   * Complete the flow with the authorization code (from the loopback
   * callback or a manually pasted code). Verifies the state, exchanges the
   * code, and persists the tokens. Returns { ok, message }.
   */
  async complete(code: string, state: string | null): Promise<{ ok: boolean; message: string }> {
    const provider = this.provider
    if (provider === null) {
      return { ok: false, message: '没有待完成的授权流程：请先点击「开始授权」。' }
    }
    const pending = provider.settlePending(state ?? '', code)
    if (pending === null) {
      return { ok: false, message: 'state 校验未通过（授权流程可能已过期或重复）。请重新点击「开始授权」。' }
    }
    let result: AuthResult
    try {
      result = await auth(provider, { serverUrl: MCP_URL, authorizationCode: code })
    } catch (error) {
      return { ok: false, message: '令牌交换失败：' + String(error instanceof Error ? error.message : error) }
    }
    if (result !== 'AUTHORIZED') {
      return { ok: false, message: '授权未完成（未知状态）。' }
    }
    return { ok: true, message: '授权成功：Cloudflare MCP 令牌已保存，MCP 工具已就绪。' }
  }

  /** Drop any pending flow (used by clear/reset). */
  abort(): void {
    if (this.provider !== null) {
      this.provider.settlePendingAbort()
    }
  }
}
