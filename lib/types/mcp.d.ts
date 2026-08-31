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
import type { Context } from '@deepseek-ai/cordis';
import { type CloudflareMcpStore } from './store.ts';
import type { OAuthFlow } from './oauth.ts';
/** Connection supervisor handle. */
export interface McpSupervisor {
    /** Start (or restart) the supervised connection. Only connects when tokens exist. */
    start(): Promise<void>;
    /** Whether a client generation is currently connected. */
    isConnected(): boolean;
    /** Number of tools currently registered from this server. */
    toolCount(): number;
    /** List the MCP server's tools (live probe; requires a connected client). */
    listTools(): Promise<string[]>;
    /** Stop the supervisor and unregister all tools. */
    dispose(): Promise<void>;
}
/**
 * Create the supervised connection for the Cloudflare MCP server.
 * @param ctx - cordis context carrying the tools registry and logger.
 * @param store - credential store (tokens gate the connection).
 * @param flow - OAuth flow providing the transport's auth provider.
 * @param callbackUrl - the loopback OAuth callback URL.
 * @returns the supervisor handle.
 */
export declare function createSupervisor(ctx: Context, store: CloudflareMcpStore, flow: OAuthFlow, callbackUrl: string): McpSupervisor;
