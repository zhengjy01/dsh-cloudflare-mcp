import { defineTool } from "@deepseek-ai/dsh-tools";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
//#region src/store.ts
/**
* dsh-cloudflare-mcp — credential/token store.
*
* Persists the Cloudflare MCP OAuth state (dynamic client registration +
* tokens) to ~/.dsh/dsh-cloudflare-mcp.json (mode 0600). Secrets never
* leave this module; the public view() masks everything. The config path
* can be overridden with DSH_CLOUDFLARE_MCP_CONFIG (used by tests).
*/
/** Default machine-wide config location (mode 0600). */
const DEFAULT_CONFIG_FILE = path.join(homedir(), ".dsh", "dsh-cloudflare-mcp.json");
/** Test override for the config location. */
function configPath() {
	const override = process.env.DSH_CLOUDFLARE_MCP_CONFIG;
	return override !== void 0 && override !== "" ? override : DEFAULT_CONFIG_FILE;
}
/** The Cloudflare MCP endpoint. */
const MCP_URL = "https://mcp.cloudflare.com/mcp";
/** Mask a credential for display, keeping only the head and tail. */
function mask(value) {
	if (!value) return "";
	if (value.length <= 8) return value.slice(0, 2) + "****";
	return value.slice(0, 4) + "****" + value.slice(-4);
}
/** Empty credentials record. */
function empty() {
	return {
		clientInformation: null,
		tokens: null,
		tokenUpdatedAt: "",
		discoveryState: null
	};
}
/** Parse an unknown JSON record into credentials (tolerates missing keys). */
function parse(raw) {
	const record = typeof raw === "object" && raw !== null ? raw : {};
	const info = record.clientInformation;
	const tokens = record.tokens;
	const str = (value) => typeof value === "string" ? value : "";
	const infoRecord = typeof info === "object" && info !== null ? info : null;
	const tokensRecord = typeof tokens === "object" && tokens !== null ? tokens : null;
	return {
		clientInformation: infoRecord !== null && str(infoRecord.client_id) !== "" ? {
			client_id: str(infoRecord.client_id),
			client_secret: infoRecord.client_secret !== void 0 ? str(infoRecord.client_secret) : void 0,
			client_id_issued_at: typeof infoRecord.client_id_issued_at === "number" ? infoRecord.client_id_issued_at : void 0,
			client_secret_expires_at: typeof infoRecord.client_secret_expires_at === "number" ? infoRecord.client_secret_expires_at : void 0,
			redirect_uris: Array.isArray(infoRecord.redirect_uris) ? infoRecord.redirect_uris.filter((u) => typeof u === "string") : void 0
		} : null,
		tokens: tokensRecord !== null && str(tokensRecord.access_token) !== "" ? {
			access_token: str(tokensRecord.access_token),
			refresh_token: tokensRecord.refresh_token !== void 0 ? str(tokensRecord.refresh_token) : void 0,
			expires_at: typeof tokensRecord.expires_at === "number" ? tokensRecord.expires_at : void 0,
			scope: typeof tokensRecord.scope === "string" ? tokensRecord.scope : void 0,
			token_type: typeof tokensRecord.token_type === "string" ? tokensRecord.token_type : void 0
		} : null,
		tokenUpdatedAt: str(record.tokenUpdatedAt),
		discoveryState: typeof record.discoveryState === "object" && record.discoveryState !== null ? record.discoveryState : null
	};
}
/**
* Small credential store backed by ~/.dsh/dsh-cloudflare-mcp.json.
* Reads are lazy and cached; writes use mode 0600 so OAuth tokens never
* leak to other local users.
*/
var CloudflareMcpStore = class {
	config = null;
	async load() {
		if (this.config !== null) return this.config;
		try {
			const raw = await readFile(configPath(), "utf8");
			this.config = parse(JSON.parse(raw));
		} catch {
			this.config = empty();
		}
		return this.config;
	}
	async save(next) {
		this.config = next;
		await mkdir(path.dirname(configPath()), { recursive: true });
		await writeFile(configPath(), JSON.stringify(next, null, 2), { mode: 384 });
	}
	/** Public, secret-free view. */
	async view(callbackUrl) {
		const cfg = await this.load();
		return {
			configured: cfg.clientInformation !== null || cfg.tokens !== null,
			authorized: cfg.tokens !== null && cfg.tokens.access_token.trim() !== "",
			tokenUpdatedAt: cfg.tokenUpdatedAt,
			clientIdMasked: cfg.clientInformation !== null ? mask(cfg.clientInformation.client_id) : "",
			callbackUrl,
			mcpUrl: MCP_URL,
			configPath: configPath()
		};
	}
	/** Clear every credential (tokens, client registration, discovery state). */
	async clearAll() {
		await this.save(empty());
	}
	/** Clear only tokens (keeps the client registration and discovery state). */
	async clearTokens() {
		const cfg = await this.load();
		cfg.tokens = null;
		cfg.tokenUpdatedAt = "";
		await this.save(cfg);
	}
	/** Clear the client registration (forces dynamic re-registration next auth). */
	async clearClientInformation() {
		const cfg = await this.load();
		cfg.clientInformation = null;
		await this.save(cfg);
	}
};
/** How long `begin()` waits for the authorization URL to materialize (ms). */
const AUTHORIZE_URL_TIMEOUT_MS = 30 * 1e3;
/**
* OAuth client provider backed by the credential store. Implements the MCP
* SDK's OAuthClientProvider contract: persisted client registration + tokens,
* memory-held PKCE verifier, and a captured authorization URL for the GUI.
*/
var CloudflareOAuthProvider = class {
	store;
	callbackUrl;
	pending = null;
	codeVerifierValue = null;
	constructor(store, callbackUrl) {
		this.store = store;
		this.callbackUrl = callbackUrl;
	}
	/** The loopback callback URL (registered on the GUI's own web server). */
	get redirectUrl() {
		return this.callbackUrl;
	}
	/** Client metadata for dynamic registration (public client + PKCE). */
	get clientMetadata() {
		return {
			client_name: "dsh-cloudflare-mcp",
			redirect_uris: [this.callbackUrl],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"]
		};
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
	async state() {
		const pending = this.pending;
		if (pending !== null) return pending.state;
		return randomUUID();
	}
	async clientInformation() {
		return (await this.store.load()).clientInformation ?? void 0;
	}
	async saveClientInformation(information) {
		const cfg = await this.store.load();
		cfg.clientInformation = information;
		await this.store.save(cfg);
	}
	async tokens() {
		const cfg = await this.store.load();
		if (cfg.tokens === null) return void 0;
		const tokens = {
			access_token: cfg.tokens.access_token,
			token_type: cfg.tokens.token_type ?? "Bearer"
		};
		if (cfg.tokens.refresh_token !== void 0) tokens.refresh_token = cfg.tokens.refresh_token;
		if (cfg.tokens.scope !== void 0) tokens.scope = cfg.tokens.scope;
		return tokens;
	}
	async saveTokens(tokens) {
		const cfg = await this.store.load();
		cfg.tokens = {
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: tokens.expires_in !== void 0 ? Date.now() + tokens.expires_in * 1e3 : void 0,
			scope: tokens.scope,
			token_type: tokens.token_type ?? "Bearer"
		};
		cfg.tokenUpdatedAt = (/* @__PURE__ */ new Date()).toISOString();
		await this.store.save(cfg);
	}
	async saveDiscoveryState(state) {
		const cfg = await this.store.load();
		cfg.discoveryState = state;
		await this.store.save(cfg);
	}
	async discoveryState() {
		return (await this.store.load()).discoveryState;
	}
	async invalidateCredentials(scope) {
		if (scope === "all") await this.store.clearAll();
		else if (scope === "client") await this.store.clearClientInformation();
		else if (scope === "tokens") await this.store.clearTokens();
		else if (scope === "verifier") this.codeVerifierValue = null;
		else if (scope === "discovery") {
			const cfg = await this.store.load();
			cfg.discoveryState = null;
			await this.store.save(cfg);
		}
	}
	async saveCodeVerifier(codeVerifier) {
		this.codeVerifierValue = codeVerifier;
	}
	async codeVerifier() {
		if (this.codeVerifierValue === null) throw new Error("OAuth flow: missing PKCE code verifier (flow may have expired)");
		return this.codeVerifierValue;
	}
	async redirectToAuthorization(authorizationUrl) {
		const pending = this.pending;
		if (pending !== null) pending.resolveAuthorizeUrl(authorizationUrl.toString());
	}
	/** Wait for the pending flow's authorization URL (bounded). */
	waitForAuthorizationUrl(timeoutMs) {
		const pending = this.pending;
		if (pending === null) return Promise.reject(/* @__PURE__ */ new Error("OAuth flow: no pending authorization"));
		return Promise.race([pending.authorizeUrlPromise, new Promise((_, reject) => {
			setTimeout(() => reject(/* @__PURE__ */ new Error("OAuth flow: authorization URL timed out")), timeoutMs).unref();
		})]);
	}
	/** Register the pending flow slot (rejects when one is already active). */
	beginPending(state) {
		if (this.pending !== null && Date.now() - this.pending.startedAt < 6e5) throw new Error("已有一个待完成的 Cloudflare 授权流程，请先完成或等待它过期。");
		let resolveAuthorizeUrl;
		let rejectAuthorizeUrl;
		const authorizeUrlPromise = new Promise((resolve, reject) => {
			resolveAuthorizeUrl = resolve;
			rejectAuthorizeUrl = reject;
		});
		const pending = {
			state,
			provider: this,
			authorizeUrlPromise,
			resolveAuthorizeUrl,
			rejectAuthorizeUrl,
			code: null,
			startedAt: Date.now()
		};
		this.pending = pending;
		this.codeVerifierValue = null;
		return pending;
	}
	/** The active pending flow (or null). */
	get pendingFlow() {
		const pending = this.pending;
		if (pending === null) return null;
		if (Date.now() - pending.startedAt > 6e5) {
			this.pending = null;
			return null;
		}
		return pending;
	}
	/** Settle a pending flow (call after the callback or manual code arrives). */
	settlePending(state, code) {
		const pending = this.pendingFlow;
		if (pending === null || pending.state !== state) return null;
		pending.code = code;
		this.pending = null;
		return pending;
	}
	/** Abort any pending flow (rejects a waiting begin() with an error). */
	settlePendingAbort() {
		const pending = this.pending;
		this.pending = null;
		this.codeVerifierValue = null;
		if (pending !== null) pending.rejectAuthorizeUrl(/* @__PURE__ */ new Error("授权流程已被取消。"));
	}
};
/**
* OAuth orchestration shared by the routes and the agent tools.
* Phase 1 (`begin`) starts discovery/registration and returns the
* authorization URL; phase 2 (`complete`) exchanges the code. The provider
* instance is created once per callback URL and reused across flows: it
* reads/writes tokens through the store, so the MCP transport keeps working
* (and auto-refreshing) between authorizations.
*/
var OAuthFlow = class {
	store;
	provider = null;
	constructor(store) {
		this.store = store;
	}
	/** The provider used by the MCP transport (created lazily). */
	get activeProvider() {
		return this.provider;
	}
	/** Get (creating if needed) the provider bound to this callback URL. */
	getProvider(callbackUrl) {
		if (this.provider === null) this.provider = new CloudflareOAuthProvider(this.store, callbackUrl);
		return this.provider;
	}
	/**
	* Start an authorization: fresh dynamic client registration (the callback
	* URL is fixed per host run, but re-registering is cheap and always
	* consistent), then the discovery + authorize-URL dance. Returns the URL
	* for the browser once it exists.
	*/
	async begin(callbackUrl) {
		await this.store.clearClientInformation();
		const provider = this.getProvider(callbackUrl);
		provider.settlePendingAbort();
		const state = await provider.state();
		const pending = provider.beginPending(state);
		auth(provider, { serverUrl: MCP_URL }).catch((error) => {
			pending.rejectAuthorizeUrl(error);
		});
		try {
			return {
				authorizeUrl: await provider.waitForAuthorizationUrl(AUTHORIZE_URL_TIMEOUT_MS),
				state
			};
		} catch (error) {
			throw error;
		}
	}
	/**
	* Complete the flow with the authorization code (from the loopback
	* callback or a manually pasted code). Verifies the state, exchanges the
	* code, and persists the tokens. Returns { ok, message }.
	*/
	async complete(code, state) {
		const provider = this.provider;
		if (provider === null) return {
			ok: false,
			message: "没有待完成的授权流程：请先点击「开始授权」。"
		};
		if (provider.settlePending(state ?? "", code) === null) return {
			ok: false,
			message: "state 校验未通过（授权流程可能已过期或重复）。请重新点击「开始授权」。"
		};
		let result;
		try {
			result = await auth(provider, {
				serverUrl: MCP_URL,
				authorizationCode: code
			});
		} catch (error) {
			return {
				ok: false,
				message: "令牌交换失败：" + String(error instanceof Error ? error.message : error)
			};
		}
		if (result !== "AUTHORIZED") return {
			ok: false,
			message: "授权未完成（未知状态）。"
		};
		return {
			ok: true,
			message: "授权成功：Cloudflare MCP 令牌已保存，MCP 工具已就绪。"
		};
	}
	/** Drop any pending flow (used by clear/reset). */
	abort() {
		if (this.provider !== null) this.provider.settlePendingAbort();
	}
};
//#endregion
//#region src/mcp.ts
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
/** Raw call result record: the bridge owns JSON-value validation after transport. */
const RawCallToolResultSchema = z.record(z.string(), z.unknown());
/** DeepSeek function-name contract: at most 64 characters. */
const MAX_PUBLIC_NAME_LENGTH = 64;
/** DeepSeek function-name contract: only `[A-Za-z0-9_-]` is allowed. */
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
/** Hex chars of the SHA-256 identity hash appended on lossy normalization. */
const HASH_LENGTH = 12;
/** Default per-tool-call timeout (ms). */
const TOOL_CALL_TIMEOUT_MS = 6e4;
/** Close-signal wait before giving up on a generation (ms). */
const GENERATION_CLOSE_TIMEOUT_MS = 5e3;
/** Reconnect backoff bounds. */
const RECONNECT = {
	initialDelayMs: 1e3,
	maxDelayMs: 3e4,
	maxAttempts: 10
};
/** Derive the model-facing public name (mcp__cloudflare__<rawName>). */
function publicToolName(rawName) {
	const joined = `mcp__cloudflare__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = createHash("sha256").update(`cloudflare\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
/** Extract readable text from an MCP content array. */
function extractText(mcpContent, toolName) {
	if (!Array.isArray(mcpContent)) return `(${toolName} returned non-content output)`;
	const parts = [];
	for (const value of mcpContent) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			parts.push("[unsupported content type: unknown]");
			continue;
		}
		const block = value;
		switch (block.type) {
			case "text":
				if (typeof block.text === "string") parts.push(block.text);
				break;
			case "image":
				parts.push(`[image: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}, content discarded]`);
				break;
			case "audio":
				parts.push(`[audio: ${typeof block.mimeType === "string" ? block.mimeType : "unknown"}, content discarded]`);
				break;
			case "resource":
			case "resource_link":
				parts.push("[resource: content discarded]");
				break;
			default: parts.push(`[unsupported content type: ${String(block.type)}]`);
		}
	}
	return parts.join("\n") || `(${toolName} returned no text content)`;
}
/**
* Create the supervised connection for the Cloudflare MCP server.
* @param ctx - cordis context carrying the tools registry and logger.
* @param store - credential store (tokens gate the connection).
* @param flow - OAuth flow providing the transport's auth provider.
* @param callbackUrl - the loopback OAuth callback URL.
* @returns the supervisor handle.
*/
function createSupervisor(ctx, store, flow, callbackUrl) {
	const label = "cloudflare-mcp";
	let client = null;
	let clientClosed = null;
	let disposers = /* @__PURE__ */ new Map();
	let reconnectTimer = null;
	let failedAttempts = 0;
	let disposed = false;
	/** Serializes every tool sync (initial and notification re-syncs). */
	let syncChain = Promise.resolve();
	const isCurrent = (generation) => !disposed && client === generation;
	function enqueueSync(generation) {
		const run = syncChain.then(async () => {
			if (!isCurrent(generation)) return;
			disposers = await syncTools(generation);
		});
		syncChain = run.catch(() => {});
		return run;
	}
	function syncTools(generation) {
		return listToolsAll(generation).then((tools) => {
			const definitions = tools.map((tool) => ({
				name: publicToolName(tool.name),
				description: tool.description ?? "",
				parameters: tool.inputSchema,
				output: {
					schema: {
						type: "object",
						properties: {
							content: {
								type: "array",
								items: {}
							},
							structuredContent: {}
						},
						required: ["content"],
						additionalProperties: false
					},
					render(_args, value) {
						return [{
							type: "text",
							text: extractText(typeof value === "object" && value !== null ? value.content : void 0, tool.name)
						}];
					}
				},
				execute: async (args, exec) => {
					const cleanArgs = typeof args === "object" && args !== null ? args : {};
					const result = await callToolUncached(generation, tool.name, cleanArgs, exec.signal);
					if (!Array.isArray(result.content)) {
						const text = "toolResult" in result ? JSON.stringify(result.toolResult) : "(no output)";
						if (result.isError === true) throw new Error(text);
						return { content: [{
							type: "text",
							text
						}] };
					}
					if (result.isError === true) throw new Error(extractText(result.content, tool.name));
					return { content: result.content };
				}
			}));
			for (const dispose of disposers.values()) dispose();
			const next = /* @__PURE__ */ new Map();
			for (const definition of definitions) next.set(definition.name, ctx.tools.register(definition));
			return next;
		});
	}
	async function listToolsAll(generation) {
		const tools = [];
		let cursor;
		do {
			const response = await generation.request({
				method: "tools/list",
				...cursor === void 0 ? {} : { params: { cursor } }
			}, ListToolsResultSchema);
			for (const tool of response.tools) tools.push({
				name: tool.name,
				description: tool.description,
				inputSchema: tool.inputSchema
			});
			cursor = response.nextCursor;
		} while (cursor !== void 0);
		return tools;
	}
	async function callToolUncached(generation, rawName, args, signal) {
		return await generation.request({
			method: "tools/call",
			params: {
				name: rawName,
				arguments: args
			}
		}, RawCallToolResultSchema, {
			signal,
			timeout: TOOL_CALL_TIMEOUT_MS
		});
	}
	function generationDown(generation) {
		if (!isCurrent(generation)) return;
		client = null;
		clientClosed = null;
		scheduleReconnect();
	}
	function waitForClose(closed) {
		return new Promise((resolve) => {
			const timeout = setTimeout(() => resolve(false), GENERATION_CLOSE_TIMEOUT_MS);
			timeout.unref();
			closed.then(() => {
				clearTimeout(timeout);
				resolve(true);
			});
		});
	}
	function scheduleReconnect() {
		if (disposed) return;
		if (failedAttempts >= RECONNECT.maxAttempts) {
			syncChain = syncChain.then(() => {
				for (const dispose of disposers.values()) dispose();
				disposers = /* @__PURE__ */ new Map();
			});
			ctx.logger.error(`${label}: giving up after ${RECONNECT.maxAttempts} reconnect attempts — tools unregistered; re-authorize or restart to reconnect`);
			return;
		}
		const delayMs = Math.min(RECONNECT.maxDelayMs, RECONNECT.initialDelayMs * 2 ** failedAttempts);
		failedAttempts += 1;
		ctx.logger.warn(`${label}: connection lost; retrying in ${delayMs}ms (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connectGeneration(false);
		}, delayMs);
		reconnectTimer.unref();
	}
	async function connectGeneration(startup) {
		if (disposed) return;
		const cfg = await store.load();
		if (cfg.tokens === null || cfg.tokens.access_token === "") {
			ctx.logger.info(`${label}: no OAuth tokens — connection deferred until authorization completes`);
			return;
		}
		const generation = new Client({
			name: "dsh-cloudflare-mcp",
			version: "0.1.0"
		}, { capabilities: {} });
		let resolveClosed;
		const closed = new Promise((resolve) => {
			resolveClosed = resolve;
		});
		let attemptSettled = false;
		let closeObserved = false;
		client = generation;
		clientClosed = closed;
		generation.onclose = () => {
			closeObserved = true;
			resolveClosed();
			if (attemptSettled) generationDown(generation);
		};
		generation.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			if (!isCurrent(generation)) return;
			ctx.logger.info(`${label}: tool list changed, re-syncing`);
			try {
				await enqueueSync(generation);
			} catch (error) {
				if (!disposed) ctx.logger.error(`${label}: tool re-sync failed: ${String(error)}`);
			}
		});
		try {
			const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { authProvider: flow.getProvider(callbackUrl) });
			await generation.connect(transport);
			if (closeObserved) {
				attemptSettled = true;
				generationDown(generation);
				return;
			}
			await enqueueSync(generation);
		} catch (error) {
			if (firstAttemptError === void 0 && startup) firstAttemptError = error;
			if (isCurrent(generation)) ctx.logger.warn(`${label}: connection attempt failed: ${String(error)}`);
			try {
				await generation.close();
			} catch {}
			const quiesced = closeObserved || await waitForClose(closed);
			attemptSettled = true;
			if (!isCurrent(generation)) return;
			if (!quiesced) {
				client = null;
				clientClosed = null;
				ctx.logger.error(`${label}: failed generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms — reconnect stopped; restart the Host to retry`);
				return;
			}
			generationDown(generation);
			return;
		}
		attemptSettled = true;
		if (closeObserved) {
			generationDown(generation);
			return;
		}
		if (!isCurrent(generation)) return;
		if (failedAttempts > 0) ctx.logger.info(`${label}: reconnected and re-synced tools (attempt ${failedAttempts}/${RECONNECT.maxAttempts})`);
	}
	let firstAttemptError = null;
	return {
		async start() {
			failedAttempts = 0;
			await connectGeneration(true);
			if (firstAttemptError !== null && client === null) {
				const error = firstAttemptError;
				firstAttemptError = null;
				throw error;
			}
		},
		isConnected() {
			return client !== null;
		},
		toolCount() {
			return disposers.size;
		},
		async listTools() {
			if (client === null) throw new Error("Cloudflare MCP 未连接。");
			return (await listToolsAll(client)).map((tool) => tool.name);
		},
		async dispose() {
			disposed = true;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			const current = client;
			const currentClosed = clientClosed;
			client = null;
			clientClosed = null;
			if (current !== null) {
				try {
					await current.close();
				} catch {}
				if (currentClosed !== null && !await waitForClose(currentClosed)) ctx.logger.error(`${label}: generation did not close within ${GENERATION_CLOSE_TIMEOUT_MS}ms during disposal`);
			}
			await syncChain;
			for (const dispose of disposers.values()) dispose();
			disposers = /* @__PURE__ */ new Map();
		}
	};
}
//#endregion
//#region src/routes.ts
/** Route paths. */
const CLOUDFLARE_MCP_API = {
	status: "/api/dsh-cloudflare-mcp/status",
	oauthStart: "/api/dsh-cloudflare-mcp/oauth/start",
	oauthCallback: "/api/dsh-cloudflare-mcp/oauth/callback",
	oauthFinish: "/api/dsh-cloudflare-mcp/oauth/finish",
	oauthRefresh: "/api/dsh-cloudflare-mcp/oauth/refresh",
	test: "/api/dsh-cloudflare-mcp/test",
	clear: "/api/dsh-cloudflare-mcp/clear"
};
/** Cap on JSON request bodies. */
const MAX_JSON_BODY_BYTES = 64 * 1024;
/** Strict loopback fence for the non-callback routes. */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** Callback route fence: loopback client + host header, any origin (cross-site navigation from the OAuth provider is expected). */
function isLoopbackCallbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	try {
		const hostUrl = new URL(`http://${host}`);
		return hostUrl.hostname === "127.0.0.1" || hostUrl.hostname === "localhost" || hostUrl.hostname === "[::1]";
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** One HTML response (used only by the OAuth callback page). */
function writeHtml(res, status, title, body) {
	const html = "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>" + title + "</title><style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0;background:#f6f7f9;color:#1f2328}.card{background:#fff;border:1px solid #e2e5e9;border-radius:12px;padding:32px 40px;max-width:520px;box-shadow:0 1px 3px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 12px}p{font-size:14px;line-height:1.7;margin:0}</style></head><body><div class=\"card\"><h1>" + title + "</h1><p>" + body + "</p></div></body></html>";
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(html);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > MAX_JSON_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Extract a string query parameter. */
function queryParam(req, name) {
	try {
		return new URL(req.url ?? "", "http://localhost").searchParams.get(name) ?? "";
	} catch {
		return "";
	}
}
/**
* Build every /api/dsh-cloudflare-mcp route (exact paths).
* @param deps - store, oauth flow, MCP supervisor, callback URL.
* @returns the route list.
*/
function makeRoutes(deps) {
	const { store, flow, supervisor, callbackUrl } = deps;
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	const statusView = async () => {
		return {
			...await store.view(callbackUrl),
			connected: supervisor.isConnected(),
			toolCount: supervisor.toolCount()
		};
	};
	return [
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.status,
			handler: async (req, res) => {
				if (!guard(req, res, "GET")) return;
				writeJson(res, 200, await statusView());
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthStart,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const { authorizeUrl } = await flow.begin(callbackUrl);
					writeJson(res, 200, {
						ok: true,
						authorizeUrl,
						callbackUrl
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						error: String(error instanceof Error ? error.message : error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthCallback,
			handler: async (req, res) => {
				if (!isLoopbackCallbackRequest(req)) {
					writeHtml(res, 403, "授权失败", "回调请求来自非本机地址，已拒绝。");
					return;
				}
				const code = queryParam(req, "code");
				const state = queryParam(req, "state");
				const error = queryParam(req, "error");
				if (error !== "") {
					flow.abort();
					writeHtml(res, 400, "授权失败", "Cloudflare 返回错误：" + error + "。请重试或使用手动粘贴 code 的方式。");
					return;
				}
				if (code === "") {
					writeHtml(res, 400, "授权失败", "回调中没有 code 参数。");
					return;
				}
				const result = await flow.complete(code, state);
				if (!result.ok) {
					writeHtml(res, 400, "授权失败", result.message);
					return;
				}
				supervisor.start().catch(() => {});
				writeHtml(res, 200, "授权成功", "Cloudflare MCP 授权已完成，令牌已保存。现在可以关闭此页面，回到 DSH 设置面板或继续对话。");
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthFinish,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 400, { error: "invalid JSON body" });
					return;
				}
				let code = typeof body.code === "string" ? body.code.trim() : "";
				if (code === "" && typeof body.redirectUrl === "string") try {
					code = new URL(body.redirectUrl).searchParams.get("code") ?? "";
				} catch {
					code = "";
				}
				if (code === "") {
					writeJson(res, 400, { error: "缺少 code（或无法从 redirectUrl 提取 code）" });
					return;
				}
				const result = await flow.complete(code, "");
				if (result.ok) supervisor.start().catch(() => {});
				writeJson(res, 200, {
					ok: result.ok,
					message: result.message,
					view: await statusView()
				});
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.oauthRefresh,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const provider = flow.activeProvider;
				if (provider === null) {
					writeJson(res, 200, {
						ok: false,
						message: "没有活动的 OAuth provider（服务重启后请先测试连接以触发刷新）。",
						view: await statusView()
					});
					return;
				}
				try {
					const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
					const result = await auth(provider, { serverUrl: "https://mcp.cloudflare.com/mcp" });
					writeJson(res, 200, {
						ok: result === "AUTHORIZED",
						message: result === "AUTHORIZED" ? "令牌刷新成功。" : "刷新未完成。",
						view: await statusView()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						message: "刷新失败：" + String(error instanceof Error ? error.message : error),
						view: await statusView()
					});
				}
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (!(await store.view(callbackUrl)).authorized) {
					writeJson(res, 200, {
						ok: false,
						error: "尚未授权：请先点击「开始授权」。",
						view: await statusView()
					});
					return;
				}
				try {
					if (!supervisor.isConnected()) await supervisor.start();
					const tools = await supervisor.listTools();
					writeJson(res, 200, {
						ok: true,
						message: `连接成功，发现 ${tools.length} 个 Cloudflare MCP 工具。`,
						tools,
						view: await statusView()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						error: String(error instanceof Error ? error.message : error),
						view: await statusView()
					});
				}
			}
		},
		{
			kind: "exact",
			path: CLOUDFLARE_MCP_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				flow.abort();
				await supervisor.dispose();
				await store.clearAll();
				writeJson(res, 200, {
					ok: true,
					message: "已清除 Cloudflare MCP 的令牌与客户端注册。",
					view: await statusView()
				});
			}
		}
	];
}
//#endregion
//#region src/index.ts
/** Stable cordis plugin name. */
const name = "cloudflare-mcp";
/** Services required before the surfaces can mount. */
const inject = [
	"tools",
	"systemPrompt",
	"webServer"
];
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 161;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const CLOUDFLARE_MCP_GUIDANCE = "本机已安装 dsh-cloudflare-mcp 插件（Cloudflare MCP 连接）：通过官方 OAuth 授权后，Cloudflare 官方 MCP 服务器（mcp.cloudflare.com）的工具以 mcp__cloudflare__* 形式可用，覆盖账户信息、Workers、Pages、DNS、R2、KV、D1、AI 等 Cloudflare API 操作。授权流程：cloudflare_mcp_oauth_start 获取授权链接 → 用户浏览器登录 Cloudflare 并授权 → 自动回调完成（也可把回调地址里的 code 交给 cloudflare_mcp_oauth_finish）。cloudflare_mcp_status 查看连接状态（不回显令牌），cloudflare_mcp_test 测试连接并列出工具。令牌存 ~/.dsh/dsh-cloudflare-mcp.json（权限 0600）。也可在 Web 设置页「Cloudflare MCP」面板中授权与测试。用户提到「Cloudflare / MCP / Workers 部署 / 查账户」时即指本插件，请据此协作。";
/**
* Mount the Cloudflare MCP tools, helper tools, routes, and announcement.
* @param ctx - host plugin context carrying tools/systemPrompt/webServer.
* @param config - plugin config from the composition row.
*/
function apply(ctx, config) {
	const announceToAgent = config?.announceToAgent !== false;
	const enabled = config?.enabled !== false;
	const store = new CloudflareMcpStore();
	const flow = new OAuthFlow(store);
	const callbackUrl = `http://127.0.0.1:${ctx.webServer.port}${CLOUDFLARE_MCP_API.oauthCallback}`;
	const supervisor = createSupervisor(ctx, store, flow, callbackUrl);
	const context = {
		store,
		flow,
		supervisor,
		callbackUrl
	};
	let disposeTools;
	let disposeRoutes;
	let disposeSection;
	let started = false;
	const sync = () => {
		if (disposeTools !== void 0) {
			disposeTools();
			disposeTools = void 0;
		}
		if (disposeRoutes !== void 0) {
			disposeRoutes();
			disposeRoutes = void 0;
		}
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		if (!enabled) return;
		disposeTools = ctx.effect(() => {
			const disposers = buildTools(context).map((tool) => ctx.tools.register(tool));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-cloudflare-mcp: tools");
		disposeRoutes = ctx.effect(() => {
			const disposers = makeRoutes(context).map((route) => ctx.webServer.register(route));
			return () => {
				for (const dispose of disposers) dispose();
			};
		}, "dsh-cloudflare-mcp: routes");
		if (announceToAgent) disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-cloudflare-mcp",
			order: SECTION_ORDER,
			text: CLOUDFLARE_MCP_GUIDANCE
		});
	};
	sync();
	(async () => {
		if (!enabled) return;
		if ((await store.view(callbackUrl)).authorized && !started) {
			started = true;
			supervisor.start().catch(() => {});
		}
	})();
	ctx.effect(() => {
		return () => {
			supervisor.dispose();
		};
	}, "dsh-cloudflare-mcp: connection");
}
/** Build every agent-facing cloudflare_mcp_* tool. */
function buildTools(ctx) {
	return [
		cloudflareMcpStatusTool(ctx),
		cloudflareMcpOAuthStartTool(ctx),
		cloudflareMcpOAuthFinishTool(ctx),
		cloudflareMcpTestTool(ctx),
		cloudflareMcpClearTool(ctx)
	];
}
/** One text content block. */
function text(value) {
	return [{
		type: "text",
		text: value
	}];
}
/** Status tool: connection state, token age, tool count. */
function cloudflareMcpStatusTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_status",
		description: "查看 dsh-cloudflare-mcp 插件状态：是否已 OAuth 授权、令牌最近更新时间、MCP 是否已连接、已注册的 Cloudflare 工具数量。不会泄露任何密钥。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					authorized: { type: "boolean" },
					connected: { type: "boolean" },
					toolCount: { type: "number" },
					tokenUpdatedAt: { type: "string" },
					mcpUrl: { type: "string" },
					configPath: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			const view = await ctx.store.view(ctx.callbackUrl);
			return {
				ok: true,
				message: "dsh-cloudflare-mcp：" + [
					view.authorized ? "已授权（令牌更新于 " + view.tokenUpdatedAt + "）" : "未授权",
					"MCP " + (ctx.supervisor.isConnected() ? "已连接" : "未连接"),
					"已注册工具 " + ctx.supervisor.toolCount() + " 个",
					"端点 " + view.mcpUrl,
					"配置路径 " + view.configPath
				].join("；") + "。" + (view.authorized ? "可直接使用 mcp__cloudflare__* 工具。" : "请用 cloudflare_mcp_oauth_start 开始授权。"),
				authorized: view.authorized,
				connected: ctx.supervisor.isConnected(),
				toolCount: ctx.supervisor.toolCount(),
				tokenUpdatedAt: view.tokenUpdatedAt,
				mcpUrl: view.mcpUrl,
				configPath: view.configPath
			};
		}
	});
}
/** OAuth start tool: begin the flow, return the browser URL. */
function cloudflareMcpOAuthStartTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_oauth_start",
		description: "开始 Cloudflare MCP 的 OAuth 授权流程：返回授权链接（authorizeUrl），让用户用浏览器打开并登录 Cloudflare 授权。授权完成后自动回调本机完成。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					authorizeUrl: { type: "string" }
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			try {
				const { authorizeUrl } = await ctx.flow.begin(ctx.callbackUrl);
				return {
					ok: true,
					message: "请在浏览器中打开以下链接完成 Cloudflare 授权（打开后登录并点击允许）：" + authorizeUrl,
					authorizeUrl
				};
			} catch (error) {
				return {
					ok: false,
					message: "开始授权失败：" + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** OAuth finish tool: manual code paste fallback. */
function cloudflareMcpOAuthFinishTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_oauth_finish",
		description: "手动完成 Cloudflare MCP 授权：把授权后浏览器地址栏里的 code 参数（或完整回调 URL）传给本工具，完成令牌交换。用于浏览器未能自动回调的情况。",
		parameters: {
			code: {
				type: "string",
				description: "授权回调 URL 中的 code 参数值"
			},
			redirectUrl: {
				type: "string",
				description: "完整的授权回调 URL（自动提取 code）"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute(args) {
			let code = typeof args.code === "string" ? args.code.trim() : "";
			if (code === "" && typeof args.redirectUrl === "string" && args.redirectUrl !== "") try {
				code = new URL(args.redirectUrl).searchParams.get("code") ?? "";
			} catch {
				code = "";
			}
			if (code === "") return {
				ok: false,
				message: "缺少 code（或无法从 redirectUrl 提取 code）。"
			};
			const result = await ctx.flow.complete(code, "");
			if (result.ok) ctx.supervisor.start().catch(() => {});
			return result;
		}
	});
}
/** Test tool: connect and list the Cloudflare MCP tools. */
function cloudflareMcpTestTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_test",
		description: "测试 Cloudflare MCP 连接：确认授权有效并列出服务器当前提供的全部工具名（如 mcp__cloudflare__* 的前身工具名）。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					},
					tools: {
						type: "array",
						items: { type: "string" }
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			if (!(await ctx.store.view(ctx.callbackUrl)).authorized) return {
				ok: false,
				message: "尚未授权：请用 cloudflare_mcp_oauth_start 开始授权。"
			};
			try {
				if (!ctx.supervisor.isConnected()) await ctx.supervisor.start();
				const tools = await ctx.supervisor.listTools();
				return {
					ok: true,
					message: "连接成功：Cloudflare MCP 提供 " + tools.length + " 个工具。" + (tools.length > 0 ? " 示例：" + tools.slice(0, 8).join("、") : ""),
					tools
				};
			} catch (error) {
				return {
					ok: false,
					message: "测试失败：" + String(error instanceof Error ? error.message : error)
				};
			}
		}
	});
}
/** Clear tool: wipe credentials and disconnect. */
function cloudflareMcpClearTool(ctx) {
	return defineTool({
		name: "cloudflare_mcp_clear",
		description: "清除 Cloudflare MCP 的全部凭据（OAuth 令牌与客户端注册）并断开连接，MCP 工具随之注销。需要用户确认后执行。",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: {
						type: "boolean",
						required: true
					},
					message: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => text(String(value.message ?? ""))
		},
		async execute() {
			ctx.flow.abort();
			await ctx.supervisor.dispose();
			await ctx.store.clearAll();
			return {
				ok: true,
				message: "已清除 Cloudflare MCP 的全部凭据，MCP 工具已注销。"
			};
		}
	});
}
//#endregion
export { CLOUDFLARE_MCP_API, CLOUDFLARE_MCP_GUIDANCE, CloudflareMcpStore, CloudflareOAuthProvider, MCP_URL, OAuthFlow, apply, configPath, createSupervisor, defineTool, inject, makeRoutes, mask, name };
