// dsh-plugin-mobile-bridge 浏览器半：设置 →「手机通道」配置页。
//
// 机制（对齐 dsh 客户端插件契约）：
//   - `window.__ModuleLoader__.load` 工厂格式，服务经 inject 声明；
//   - `ctx.settingsScope.bind({ namespace })` 绑定宿主设置命名空间
//     （remote 转发的 settings/document-updated 驱动快照刷新）；
//   - `ctx.slots.inject('settings.section', ...)` 注册设置页（与琥珀主题、
//     agent-presets 同机制）；字段写入 `scope.set(field, value)` 走
//     settings.mutate RPC 持久化，宿主半监听 settings/updated 热重启桥。
window.__ModuleLoader__.load({
	id: "dsh-plugin-mobile-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const NS = "mobile-bridge";
		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;

		const labelStyle = {
			display: "block",
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary)",
			marginBottom: 4
		};
		const inputStyle = {
			width: "100%",
			boxSizing: "border-box",
			padding: "6px 10px",
			fontSize: 13,
			color: "var(--dsw-alias-label-primary)",
			background: "var(--dsw-alias-bg-layer-1)",
			border: "1px solid var(--dsw-alias-bg-layer-3)",
			borderRadius: 6,
			outline: "none"
		};
		const hintStyle = {
			fontSize: 11,
			color: "var(--dsw-alias-label-tertiary)",
			marginTop: 4
		};
		const buttonStyle = {
			padding: "6px 16px",
			fontSize: 13,
			color: "#fff",
			background: "var(--dsw-alias-brand-primary)",
			border: "none",
			borderRadius: 6,
			cursor: "pointer"
		};

		/** 「手机通道」设置页：relay 地址 / 配对码 / 本机 dsh 地址 + 状态。 */
		function MobileBridgeSection() {
			const [snap, setSnap] = react.useState(() => scope.getSnapshot());
			react.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), []);
			const value = snap.value ?? {};
			const [form, setForm] = react.useState(() => ({
				relayUrl: value.relayUrl ?? "",
				code: value.code ?? "",
				dshUrl: value.dshUrl ?? "",
				pairingCode: value.pairingCode ?? ""
			}));
			const [msg, setMsg] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [stat, setStat] = react.useState(null);
			const [invite, setInvite] = react.useState(null);
			const [inviteBusy, setInviteBusy] = react.useState(false);
			const [inviteMsg, setInviteMsg] = react.useState("");
			const doInvite = async () => {
				setInviteBusy(true);
				setInviteMsg("生成中…");
				setInvite(null);
				try {
					const res = await fetch("/mobile-bridge/invite", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ name: "" })
					});
					const j = await res.json();
					if (j.code !== 200) throw new Error(j.message || "生成失败");
					setInvite(j.result);
					setInviteMsg("");
				} catch (e) {
					setInviteMsg(`生成失败：${(e && e.message) || e}`);
				} finally {
					setInviteBusy(false);
				}
			};
			react.useEffect(() => {
				let alive = true;
				const tick = async () => {
					try {
						const res = await fetch("/mobile-bridge/status");
						if (!res.ok) return;
						const data = await res.json();
						if (alive) setStat(data);
					} catch {}
				};
				tick();
				const timer = setInterval(tick, 5000);
				return () => { alive = false; clearInterval(timer); };
			}, []);
			const dirty = form.relayUrl !== (value.relayUrl ?? "")
				|| form.code !== (value.code ?? "")
				|| form.dshUrl !== (value.dshUrl ?? "")
				|| form.pairingCode !== (value.pairingCode ?? "");
			const save = async () => {
				setBusy(true);
				setMsg("保存中…");
				try {
					await scope.set("relayUrl", form.relayUrl);
					await scope.set("code", form.code);
					await scope.set("dshUrl", form.dshUrl);
					await scope.set("pairingCode", form.pairingCode);
					setMsg("已保存，桥即时重启生效 ✓");
				} catch (e) {
					setMsg(`保存失败：${(e && e.message) || e}`);
				} finally {
					setBusy(false);
				}
			};
			const row = (key, label, hint, placeholder) => jsxs("div", {
				style: { marginBottom: 14 },
				children: [
					jsxs("div", {
						style: labelStyle,
						children: [label, jsx("span", {
							style: { marginLeft: 8, color: "var(--dsw-alias-link)" },
							children: form[key] !== (value[key] ?? "") ? "（未保存）" : ""
						})]
					}),
					jsx("input", {
						style: inputStyle,
						value: form[key],
						placeholder,
						spellCheck: false,
						onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value }))
					}),
					hint ? jsx("div", { style: hintStyle, children: hint }) : null
				]
			});
			const modeText = snap.mode === "host"
				? "持久化：Host 设置文档"
				: "持久化：内存模式（连接偏好为进程本地，改动不落盘）";
			return jsxs("div", {
				style: {
					maxWidth: 460,
					padding: "8px 4px",
					fontSize: 13,
					color: "var(--dsw-alias-label-primary)"
				},
				children: [
					jsxs("div", {
						style: { lineHeight: 1.7, color: "var(--dsw-alias-label-secondary)", marginBottom: 16 },
						children: [
							"桌面桥随 dsh 启停，把公网 relay 的流量（HTTP/WS）转发到本机 dsh。",
							jsx("br", {}),
							"手机 App 选「云端转发」，填同一 relay 地址与配对码即可直连。"
						]
					}),
					row("relayUrl", "Relay 地址", "公网 relay 的 ws(s) 地址，如 wss://your-vps:8787", "ws://127.0.0.1:8787"),
					row("code", "房间码", "旧共享码模式用（无配对凭证时兜底）；≥6 位，手机填同一值；留空且无凭证则桥停用", "test-code-123456"),
					row("pairingCode", "Host 配对码", "首次配对用的一次性码（管理台/环境视图生成，role=host）；配对成功后自动改用设备令牌并清空", "XXXX-XXXX"),
					row("dshUrl", "本机 dsh 地址", "桥转发的目标，默认 http://127.0.0.1:3080", "http://127.0.0.1:3080"),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 12, marginTop: 16 },
						children: [
							jsxs("button", {
								style: { ...buttonStyle, opacity: busy || !dirty ? 0.5 : 1 },
								disabled: busy || !dirty,
								onClick: save,
								children: ["保存并生效"]
							}),
							jsx("span", {
								style: { fontSize: 12, color: msg.startsWith("保存失败") ? "#c0392b" : "var(--dsw-alias-label-secondary)" },
								children: msg
							})
						]
					}),
					jsxs("div", {
						style: { marginTop: 20, paddingTop: 12, borderTop: "1px solid var(--dsw-alias-bg-layer-3)" },
						children: [
							jsx("div", { style: labelStyle, children: "手机连接二维码" }),
							jsx("div", {
								style: hintStyle,
								children: "桥完成配对后，生成一次性配对码二维码，家人扫码即自动接入本环境（免管理台）。"
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: 12, marginTop: 8 },
								children: [
									jsxs("button", {
										style: { ...buttonStyle, opacity: inviteBusy || !(stat && stat.paired) ? 0.5 : 1 },
										disabled: inviteBusy || !(stat && stat.paired),
										onClick: doInvite,
										children: ["生成手机配对码"]
									}),
									jsx("span", { style: { fontSize: 12, color: "#c0392b" }, children: inviteMsg })
								]
							}),
							invite ? jsxs("div", {
								style: { marginTop: 12, display: "flex", gap: 16, alignItems: "flex-start" },
								children: [
									jsx("img", {
										src: invite.qr,
										alt: "pairing qr",
										style: { width: 180, height: 180, border: "1px solid var(--dsw-alias-bg-layer-3)", borderRadius: 6, background: "#fff" }
									}),
									jsxs("div", { style: { fontSize: 12, lineHeight: 1.9, wordBreak: "break-all" }, children: [
										jsxs("div", { children: ["配对码：", jsx("b", { style: { fontSize: 16, letterSpacing: 2 }, children: invite.code })] }),
										jsxs("div", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: ["payload：", invite.payload] }),
										jsx("div", { style: hintStyle, children: "600 秒内有效，仅可使用一次。" })
									]})
								]
							}) : null
						]
					}),
					jsxs("div", {
						style: {
							marginTop: 20,
							paddingTop: 12,
							borderTop: "1px solid var(--dsw-alias-bg-layer-3)",
							fontSize: 11,
							color: "var(--dsw-alias-label-tertiary)",
							lineHeight: 1.8
						},
						children: [
							jsxs("div", {
								children: [
									"桥状态：",
									stat
										? jsxs("span", {
											style: { color: stat.connected ? "#2e7d32" : "#c0392b" },
											children: [
												stat.connected ? "已连 relay" : "未连 relay",
												" · ",
												stat.paired ? `已配对 ${stat.deviceId || ""}` : "未配对",
												" · ",
												stat.peerOnline ? "手机对端在线" : "手机对端离线",
												` · 手机在线 ${stat.clientCount ?? 0}`,
												" · 活动隧道 ", String(stat.tunnels),
												stat.since ? ` · 自 ${stat.since.slice(11, 19)}Z` : "",
												stat.lastReject ? ` · 最近拒绝 ${stat.lastReject}` : ""
											]
										})
										: "获取中…"
								]
							}),
							jsxs("div", { children: ["状态：", modeText] }),
							jsxs("div", { children: ["可写：", snap.writable ? "是" : "否（只读镜像）"] }),
							jsxs("div", { children: ["当前配对码：", form.code ? (form.code.length < 6 ? "过短，桥不会启动" : "已设置") : "未设置（桥停用）"] }),
							jsx("div", { children: "配置存于 Host 设置文档 mobile-bridge 命名空间；字段清除后回落到 $DSH_HOME/mobile-bridge.json（base 组合层）。" })
						]
					})
				]
			});
		}

		/** 必需服务：slots（设置页槽位）、settingsScope + remote（设置命名空间镜像）。 */
		const inject = ["slots", "remote", "settingsScope"];

		function apply(ctx) {
			scope = ctx.settingsScope.bind({ namespace: NS });
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "mobile-bridge",
				order: 60,
				label: "手机通道"
			}, MobileBridgeSection));
		}

		let scope;

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
