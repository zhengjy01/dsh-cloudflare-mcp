/**
 * Browser-side API client for the /api/dsh-cloudflare-mcp route family. The
 * only data access path the settings panel uses — plain fetch, same origin.
 */
/** Public status view (mirrors the host contract). */
export interface CloudflareMcpStatusView {
    configured: boolean;
    authorized: boolean;
    tokenUpdatedAt: string;
    clientIdMasked: string;
    callbackUrl: string;
    mcpUrl: string;
    configPath: string;
    connected: boolean;
    toolCount: number;
}
/** Error carrying the route's JSON error message. */
export declare class CloudflareMcpApiError extends Error {
    constructor(message: string);
}
/** The Cloudflare MCP panel API. */
export declare class CloudflareMcpApi {
    status(): Promise<CloudflareMcpStatusView>;
    oauthStart(): Promise<{
        ok: boolean;
        authorizeUrl?: string;
        error?: string;
    }>;
    oauthFinish(code: string, redirectUrl: string): Promise<{
        ok: boolean;
        message: string;
        view: CloudflareMcpStatusView;
    }>;
    oauthRefresh(): Promise<{
        ok: boolean;
        message: string;
        view: CloudflareMcpStatusView;
    }>;
    test(): Promise<{
        ok: boolean;
        message?: string;
        error?: string;
        tools?: string[];
        view: CloudflareMcpStatusView;
    }>;
    clear(): Promise<{
        ok: boolean;
        message: string;
        view: CloudflareMcpStatusView;
    }>;
}
