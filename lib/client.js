window.__ModuleLoader__.load({
	id: "dsh-cloudflare-mcp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/api.ts
		/** Error carrying the route's JSON error message. */
		var CloudflareMcpApiError = class extends Error {
			constructor(message) {
				super(message);
				this.name = "CloudflareMcpApiError";
			}
		};
		/** Parse a JSON response or throw a CloudflareMcpApiError. */
		async function readJson(response) {
			let body;
			try {
				body = await response.json();
			} catch {
				throw new CloudflareMcpApiError(`HTTP ${response.status}: invalid JSON response`);
			}
			if (!response.ok) throw new CloudflareMcpApiError(typeof body === "object" && body !== null && typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
			return body;
		}
		/** Plain fetch helper with an error wrapper. */
		async function request(path, init) {
			let response;
			try {
				response = await fetch(path, init);
			} catch (error) {
				throw new CloudflareMcpApiError("网络请求失败: " + String(error instanceof Error ? error.message : error));
			}
			return readJson(response);
		}
		/** The Cloudflare MCP panel API. */
		var CloudflareMcpApi = class {
			async status() {
				return request("/api/dsh-cloudflare-mcp/status");
			}
			async oauthStart() {
				return request("/api/dsh-cloudflare-mcp/oauth/start", { method: "POST" });
			}
			async oauthFinish(code, redirectUrl) {
				return request("/api/dsh-cloudflare-mcp/oauth/finish", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						code,
						redirectUrl
					})
				});
			}
			async oauthRefresh() {
				return request("/api/dsh-cloudflare-mcp/oauth/refresh", { method: "POST" });
			}
			async test() {
				return request("/api/dsh-cloudflare-mcp/test", { method: "POST" });
			}
			async clear() {
				return request("/api/dsh-cloudflare-mcp/clear", { method: "POST" });
			}
		};
		//#endregion
		//#region src/client/CloudflarePanel.tsx
		/**
		* Cloudflare MCP settings panel — rendered inside the web settings page
		* (settings.section entry). Drives the OAuth authorize flow (popup + manual
		* code paste), shows connection state and the registered MCP tool count,
		* and offers one-click test / refresh / clear. Plain React, inline styles.
		*/
		/** Module-level API client (stateless; the component closes over it). */
		const api = new CloudflareMcpApi();
		/** One shared style sheet (kept tiny and theme-agnostic). */
		const s = {
			card: {
				display: "flex",
				flexDirection: "column",
				gap: "10px",
				maxWidth: "620px",
				padding: "14px 16px",
				borderRadius: "10px",
				border: "1px solid rgba(128,128,128,0.3)",
				fontSize: "13px",
				color: "inherit"
			},
			title: {
				fontWeight: 600,
				fontSize: "13px",
				margin: 0
			},
			status: {
				fontSize: "12px",
				opacity: .85
			},
			statusWarn: {
				fontSize: "12px",
				opacity: .9,
				color: "#c9763a"
			},
			row: {
				display: "flex",
				gap: "6px",
				alignItems: "center",
				flexWrap: "wrap"
			},
			input: {
				width: "100%",
				boxSizing: "border-box",
				padding: "5px 8px",
				borderRadius: "6px",
				border: "1px solid rgba(128,128,128,0.35)",
				background: "rgba(128,128,128,0.08)",
				color: "inherit",
				fontSize: "12px"
			},
			flex: { flex: 1 },
			button: {
				padding: "4px 10px",
				borderRadius: "6px",
				cursor: "pointer",
				border: "1px solid rgba(128,128,128,0.4)",
				background: "rgba(128,128,128,0.14)",
				color: "inherit",
				fontSize: "12px",
				whiteSpace: "nowrap"
			},
			msg: {
				fontSize: "12px",
				whiteSpace: "pre-wrap",
				wordBreak: "break-all",
				opacity: .9
			},
			hint: {
				fontSize: "11px",
				opacity: .75,
				lineHeight: 1.6
			}
		};
		/** Status line for the current view. */
		function statusText(view) {
			if (view === null) return "加载中…";
			if (!view.authorized) return "未授权 — 点击「开始授权」并在 Cloudflare 登录页完成授权后，MCP 工具即可用。";
			const connected = view.connected ? "已连接" : "未连接";
			return `已授权 · 令牌更新于 ${view.tokenUpdatedAt} · MCP ${connected} · 工具 ${view.toolCount} 个`;
		}
		/** The settings panel component. */
		function CloudflareMcpSettingsPanel() {
			const [view, setView] = (0, react.useState)(null);
			const [code, setCode] = (0, react.useState)("");
			const [tools, setTools] = (0, react.useState)([]);
			const [busy, setBusy] = (0, react.useState)(false);
			const [msg, setMsg] = (0, react.useState)("");
			const refreshStatus = (0, react.useCallback)(async () => {
				try {
					setView(await api.status());
				} catch (error) {
					setMsg("读取状态失败: " + String(error instanceof Error ? error.message : error));
				}
			}, []);
			(0, react.useEffect)(() => {
				refreshStatus();
			}, [refreshStatus]);
			(0, react.useEffect)(() => {
				const onFocus = () => {
					refreshStatus();
				};
				window.addEventListener("focus", onFocus);
				return () => window.removeEventListener("focus", onFocus);
			}, [refreshStatus]);
			/** Run one async panel action with busy/message bookkeeping. */
			const run = async (action) => {
				setBusy(true);
				setMsg("");
				try {
					const result = await action();
					if (result !== void 0) setMsg(result.message);
				} catch (error) {
					setMsg("操作失败: " + String(error instanceof Error ? error.message : error));
				} finally {
					setBusy(false);
				}
			};
			const authorize = () => {
				run(async () => {
					const result = await api.oauthStart();
					if (!result.ok || result.authorizeUrl === void 0) return { message: "[failed] " + (result.error ?? "开始授权失败") };
					window.open(result.authorizeUrl, "_blank", "noopener");
					return { message: "已在新标签页打开 Cloudflare 授权页。登录并点击允许后会自动跳回本机完成；若停留在回调地址，复制地址栏 URL（或其中的 code）粘贴到下方完成。" };
				});
			};
			const finish = () => {
				run(async () => {
					const result = await api.oauthFinish(code, "");
					setCode("");
					setView(result.view);
					return { message: (result.ok ? "[ok] " : "[failed] ") + result.message };
				});
			};
			const refreshTokens = () => {
				run(async () => {
					const result = await api.oauthRefresh();
					setView(result.view);
					return { message: (result.ok ? "[ok] " : "[failed] ") + result.message };
				});
			};
			const test = () => {
				run(async () => {
					const result = await api.test();
					setView(result.view);
					if (result.ok && result.tools !== void 0) setTools(result.tools);
					return { message: result.ok ? result.message ?? "连接成功。" : "[failed] " + (result.error ?? "") };
				});
			};
			const clear = () => {
				run(async () => {
					if (!window.confirm("确定清除 Cloudflare MCP 的全部凭据吗？MCP 工具将注销，之后需要重新授权。")) return { message: "已取消。" };
					const result = await api.clear();
					setView(result.view);
					setTools([]);
					return { message: result.message };
				});
			};
			const authorized = Boolean(view && view.authorized);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: s.card,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						style: s.title,
						children: "Cloudflare MCP"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: authorized ? s.status : s.statusWarn,
						children: statusText(view)
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.hint,
						children: [
							"通过官方 OAuth 连接 mcp.cloudflare.com，授权后 Cloudflare API 工具以 mcp__cloudflare__* 形式在会话中可用 （账户信息、Workers、Pages、DNS、R2、KV、D1、AI 等）。令牌存 ",
							view?.configPath ?? "~/.dsh/dsh-cloudflare-mcp.json",
							"（权限 0600）。"
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: authorize,
								disabled: busy || authorized,
								children: "开始授权"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: refreshTokens,
								disabled: busy || !authorized,
								children: "刷新令牌"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: test,
								disabled: busy || !authorized,
								children: "测试连接"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								style: s.button,
								onClick: clear,
								disabled: busy || !authorized,
								children: "清除凭据"
							})
						]
					}),
					!authorized && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							style: {
								...s.input,
								...s.flex
							},
							placeholder: "授权后若未自动完成，粘贴回调地址或 code",
							value: code,
							onChange: (event) => setCode(event.target.value)
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							style: s.button,
							onClick: finish,
							disabled: busy || code.trim() === "",
							children: "完成授权"
						})]
					}),
					tools.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: s.hint,
						children: [
							"已发现的 MCP 工具（",
							tools.length,
							"）：",
							tools.slice(0, 12).join("、"),
							tools.length > 12 ? "…" : ""
						]
					}),
					msg !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: s.msg,
						children: msg
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services. */
		const inject = ["slots"];
		/**
		* Register the Cloudflare MCP settings page.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			try {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "cloudflare-mcp",
					order: 320,
					label: () => "Cloudflare MCP"
				}, CloudflareMcpSettingsPanel));
			} catch (error) {
				console.warn("[dsh-cloudflare-mcp] settings panel registration failed:", error);
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map