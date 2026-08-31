/**
 * dsh-cloudflare-mcp — credential/token store.
 *
 * Persists the Cloudflare MCP OAuth state (dynamic client registration +
 * tokens) to ~/.dsh/dsh-cloudflare-mcp.json (mode 0600). Secrets never
 * leave this module; the public view() masks everything. The config path
 * can be overridden with DSH_CLOUDFLARE_MCP_CONFIG (used by tests).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default machine-wide config location (mode 0600). */
export const DEFAULT_CONFIG_FILE = path.join(homedir(), '.dsh', 'dsh-cloudflare-mcp.json')

/** Test override for the config location. */
export function configPath(): string {
  const override = process.env.DSH_CLOUDFLARE_MCP_CONFIG
  return override !== undefined && override !== '' ? override : DEFAULT_CONFIG_FILE
}

/** The Cloudflare MCP endpoint. */
export const MCP_URL = 'https://mcp.cloudflare.com/mcp'

/** Dynamic-client registration record (OAuthClientInformationMixed subset). */
export interface StoredClientInformation {
  client_id: string
  client_secret?: string
  client_id_issued_at?: number
  client_secret_expires_at?: number
  /** Registered redirect URIs (the loopback callback). */
  redirect_uris?: string[]
  [key: string]: unknown
}

/** OAuth tokens (OAuthTokens subset, JsonValue-safe). */
export interface StoredTokens {
  access_token: string
  refresh_token?: string
  expires_at?: number
  scope?: string
  token_type?: string
}

/** Persisted shape. Secrets never leave this module. */
export interface CloudflareMcpCredentials {
  clientInformation: StoredClientInformation | null
  tokens: StoredTokens | null
  /** ISO timestamp of the last successful token exchange/refresh. */
  tokenUpdatedAt: string
  /** Cached RFC 9728 discovery state (no secrets). */
  discoveryState: Record<string, unknown> | null
}

/** Public, secret-free status view. */
export interface CloudflareMcpConfigView {
  configured: boolean
  authorized: boolean
  tokenUpdatedAt: string
  clientIdMasked: string
  callbackUrl: string
  mcpUrl: string
  configPath: string
}

/** Mask a credential for display, keeping only the head and tail. */
export function mask(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return value.slice(0, 2) + '****'
  return value.slice(0, 4) + '****' + value.slice(-4)
}

/** Empty credentials record. */
function empty(): CloudflareMcpCredentials {
  return {
    clientInformation: null,
    tokens: null,
    tokenUpdatedAt: '',
    discoveryState: null,
  }
}

/** Parse an unknown JSON record into credentials (tolerates missing keys). */
function parse(raw: unknown): CloudflareMcpCredentials {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const info = record.clientInformation
  const tokens = record.tokens
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const infoRecord = typeof info === 'object' && info !== null ? info as Record<string, unknown> : null
  const tokensRecord = typeof tokens === 'object' && tokens !== null ? tokens as Record<string, unknown> : null
  return {
    clientInformation: infoRecord !== null && str(infoRecord.client_id) !== ''
      ? {
          client_id: str(infoRecord.client_id),
          client_secret: infoRecord.client_secret !== undefined ? str(infoRecord.client_secret) : undefined,
          client_id_issued_at: typeof infoRecord.client_id_issued_at === 'number' ? infoRecord.client_id_issued_at : undefined,
          client_secret_expires_at: typeof infoRecord.client_secret_expires_at === 'number' ? infoRecord.client_secret_expires_at : undefined,
          redirect_uris: Array.isArray(infoRecord.redirect_uris)
            ? infoRecord.redirect_uris.filter((u): u is string => typeof u === 'string')
            : undefined,
        }
      : null,
    tokens: tokensRecord !== null && str(tokensRecord.access_token) !== ''
      ? {
          access_token: str(tokensRecord.access_token),
          refresh_token: tokensRecord.refresh_token !== undefined ? str(tokensRecord.refresh_token) : undefined,
          expires_at: typeof tokensRecord.expires_at === 'number' ? tokensRecord.expires_at : undefined,
          scope: typeof tokensRecord.scope === 'string' ? tokensRecord.scope : undefined,
          token_type: typeof tokensRecord.token_type === 'string' ? tokensRecord.token_type : undefined,
        }
      : null,
    tokenUpdatedAt: str(record.tokenUpdatedAt),
    discoveryState: typeof record.discoveryState === 'object' && record.discoveryState !== null
      ? record.discoveryState as Record<string, unknown>
      : null,
  }
}

/**
 * Small credential store backed by ~/.dsh/dsh-cloudflare-mcp.json.
 * Reads are lazy and cached; writes use mode 0600 so OAuth tokens never
 * leak to other local users.
 */
export class CloudflareMcpStore {
  config: CloudflareMcpCredentials | null = null

  async load(): Promise<CloudflareMcpCredentials> {
    if (this.config !== null) return this.config
    try {
      const raw = await readFile(configPath(), 'utf8')
      this.config = parse(JSON.parse(raw))
    } catch {
      // Missing or unreadable config file: treat as unconfigured.
      this.config = empty()
    }
    return this.config
  }

  async save(next: CloudflareMcpCredentials): Promise<void> {
    this.config = next
    await mkdir(path.dirname(configPath()), { recursive: true })
    await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 })
  }

  /** Public, secret-free view. */
  async view(callbackUrl: string): Promise<CloudflareMcpConfigView> {
    const cfg = await this.load()
    return {
      configured: cfg.clientInformation !== null || cfg.tokens !== null,
      authorized: cfg.tokens !== null && cfg.tokens.access_token.trim() !== '',
      tokenUpdatedAt: cfg.tokenUpdatedAt,
      clientIdMasked: cfg.clientInformation !== null ? mask(cfg.clientInformation.client_id) : '',
      callbackUrl,
      mcpUrl: MCP_URL,
      configPath: configPath(),
    }
  }

  /** Clear every credential (tokens, client registration, discovery state). */
  async clearAll(): Promise<void> {
    await this.save(empty())
  }

  /** Clear only tokens (keeps the client registration and discovery state). */
  async clearTokens(): Promise<void> {
    const cfg = await this.load()
    cfg.tokens = null
    cfg.tokenUpdatedAt = ''
    await this.save(cfg)
  }

  /** Clear the client registration (forces dynamic re-registration next auth). */
  async clearClientInformation(): Promise<void> {
    const cfg = await this.load()
    cfg.clientInformation = null
    await this.save(cfg)
  }
}
