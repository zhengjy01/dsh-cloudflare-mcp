/**
 * dsh-cloudflare-mcp — loopback HTTP routes for the web settings panel and
 * the OAuth callback.
 *
 * Route family: /api/dsh-cloudflare-mcp/*. All routes are loopback-only
 * (127.0.0.1/localhost, same-origin) except the OAuth callback, which must
 * accept the browser landing from mcp.cloudflare.com — it still requires a
 * loopback client and verifies the OAuth `state` inside the flow.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CloudflareMcpStore } from './store.ts';
import type { OAuthFlow } from './oauth.ts';
import type { McpSupervisor } from './mcp.ts';
/** Route paths. */
export declare const CLOUDFLARE_MCP_API: {
    readonly status: "/api/dsh-cloudflare-mcp/status";
    readonly oauthStart: "/api/dsh-cloudflare-mcp/oauth/start";
    readonly oauthCallback: "/api/dsh-cloudflare-mcp/oauth/callback";
    readonly oauthFinish: "/api/dsh-cloudflare-mcp/oauth/finish";
    readonly oauthRefresh: "/api/dsh-cloudflare-mcp/oauth/refresh";
    readonly test: "/api/dsh-cloudflare-mcp/test";
    readonly clear: "/api/dsh-cloudflare-mcp/clear";
};
/** Route handler context. */
export interface RouteContext {
    store: CloudflareMcpStore;
    flow: OAuthFlow;
    supervisor: McpSupervisor;
    /** The loopback OAuth callback URL. */
    callbackUrl: string;
}
/**
 * Build every /api/dsh-cloudflare-mcp route (exact paths).
 * @param deps - store, oauth flow, MCP supervisor, callback URL.
 * @returns the route list.
 */
export declare function makeRoutes(deps: RouteContext): ({
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/status";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/start";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/callback";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/finish";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/oauth/refresh";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/test";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
} | {
    kind: "exact";
    path: "/api/dsh-cloudflare-mcp/clear";
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
})[];
