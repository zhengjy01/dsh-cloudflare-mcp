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
import { type OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { type CloudflareMcpStore } from './store.ts';
/** How long a pending authorization flow stays valid (ms). */
export declare const PENDING_FLOW_TTL_MS: number;
/** How long `begin()` waits for the authorization URL to materialize (ms). */
export declare const AUTHORIZE_URL_TIMEOUT_MS: number;
/** One in-flight authorization flow (single-slot; concurrency rejected). */
export interface PendingFlow {
    state: string;
    provider: CloudflareOAuthProvider;
    /** Resolves with the authorization URL once redirectToAuthorization fires. */
    authorizeUrlPromise: Promise<string>;
    resolveAuthorizeUrl: (url: string) => void;
    rejectAuthorizeUrl: (error: unknown) => void;
    /** Set when the browser callback (or manual code) arrives. */
    code: string | null;
    /** Timestamp of begin(), for TTL eviction. */
    startedAt: number;
}
/**
 * OAuth client provider backed by the credential store. Implements the MCP
 * SDK's OAuthClientProvider contract: persisted client registration + tokens,
 * memory-held PKCE verifier, and a captured authorization URL for the GUI.
 */
export declare class CloudflareOAuthProvider implements OAuthClientProvider {
    private readonly store;
    private readonly callbackUrl;
    private pending;
    private codeVerifierValue;
    constructor(store: CloudflareMcpStore, callbackUrl: string);
    /** The loopback callback URL (registered on the GUI's own web server). */
    get redirectUrl(): string;
    /** Client metadata for dynamic registration (public client + PKCE). */
    get clientMetadata(): OAuthClientMetadata;
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
    state(): Promise<string>;
    clientInformation(): Promise<OAuthClientInformationMixed | undefined>;
    saveClientInformation(information: OAuthClientInformationMixed): Promise<void>;
    tokens(): Promise<OAuthTokens | undefined>;
    saveTokens(tokens: OAuthTokens): Promise<void>;
    saveDiscoveryState(state: OAuthDiscoveryState): Promise<void>;
    discoveryState(): Promise<OAuthDiscoveryState | undefined>;
    invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void>;
    saveCodeVerifier(codeVerifier: string): Promise<void>;
    codeVerifier(): Promise<string>;
    redirectToAuthorization(authorizationUrl: URL): Promise<void>;
    /** Wait for the pending flow's authorization URL (bounded). */
    waitForAuthorizationUrl(timeoutMs: number): Promise<string>;
    /** Register the pending flow slot (rejects when one is already active). */
    beginPending(state: string): PendingFlow;
    /** The active pending flow (or null). */
    get pendingFlow(): PendingFlow | null;
    /** Settle a pending flow (call after the callback or manual code arrives). */
    settlePending(state: string, code: string): PendingFlow | null;
    /** Abort any pending flow (rejects a waiting begin() with an error). */
    settlePendingAbort(): void;
}
/**
 * OAuth orchestration shared by the routes and the agent tools.
 * Phase 1 (`begin`) starts discovery/registration and returns the
 * authorization URL; phase 2 (`complete`) exchanges the code. The provider
 * instance is created once per callback URL and reused across flows: it
 * reads/writes tokens through the store, so the MCP transport keeps working
 * (and auto-refreshing) between authorizations.
 */
export declare class OAuthFlow {
    private readonly store;
    private provider;
    constructor(store: CloudflareMcpStore);
    /** The provider used by the MCP transport (created lazily). */
    get activeProvider(): CloudflareOAuthProvider | null;
    /** Get (creating if needed) the provider bound to this callback URL. */
    getProvider(callbackUrl: string): CloudflareOAuthProvider;
    /**
     * Start an authorization: fresh dynamic client registration (the callback
     * URL is fixed per host run, but re-registering is cheap and always
     * consistent), then the discovery + authorize-URL dance. Returns the URL
     * for the browser once it exists.
     */
    begin(callbackUrl: string): Promise<{
        authorizeUrl: string;
        state: string;
    }>;
    /**
     * Complete the flow with the authorization code (from the loopback
     * callback or a manually pasted code). Verifies the state, exchanges the
     * code, and persists the tokens. Returns { ok, message }.
     */
    complete(code: string, state: string | null): Promise<{
        ok: boolean;
        message: string;
    }>;
    /** Drop any pending flow (used by clear/reset). */
    abort(): void;
}
