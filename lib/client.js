// dsh-relay-plugin 浏览器半：插件管理页「行配置」页 + 桥状态 / 二维码。
//
// 契约（现行 dsh web，2026-09 起）：
//   - 注册进插件管理页的 plugins.row.config 槽位（key = <包名>#<行 id>）；
//   - 页面组件接收 { view, form }：form.state = ConfigFormSnapshot（Host 投影的
//     volatile 字段值），form.mutate(ops, revision) 提交路径编辑，宿主校验并写回
//     profile patch 本行 config，桥随 loader/volatile-update 热重启；
//   - 旧 settingsScope 服务与 settings.section 槽位已废除——声明缺失的服务会让
//     fiber 永久 PENDING（表现为「waiting for activation」）。
window.__ModuleLoader__.load({
	id: "dsh-relay-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		const jsx = react_jsx_runtime.jsx;
		const jsxs = react_jsx_runtime.jsxs;

		const NS = "mobile-bridge";
		const ROW_KEY = "dsh-relay-plugin#mobile-bridge";
		const FIELDS = [
			{ key: "relayUrl", label: "Relay 地址", hint: "公网 relay 的 ws(s) 地址，如 wss://your-vps:8787", placeholder: "ws://127.0.0.1:8787" },
			{ key: "code", label: "房间码", hint: "旧共享码模式用（无配对凭证时兜底）；≥6 位，手机填同一值；留空且无凭证则桥停用", placeholder: "test-code-123456" },
			{ key: "pairingCode", label: "Host 配对码", hint: "首次配对用的一次性码（管理台/环境视图生成，role=host）；配对成功后自动改用设备令牌并清空", placeholder: "XXXX-XXXX" },
			{ key: "dshUrl", label: "本机 dsh 地址", hint: "桥转发的目标，默认 http://127.0.0.1:3080", placeholder: "http://127.0.0.1:3080" },
		];

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

		/** useBridgeStatus：/mobile-bridge/status 5s 轮询。 */
		function useBridgeStatus() {
			const [stat, setStat] = react.useState(null);
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
			return stat;
		}

		/** 行配置页：view=summary 一行简介；view=page 完整表单（form 由插件管理页所有者提供）。 */
		function RowConfigPage({ view, form }) {
			if (view === "summary") {
				return jsx("span", {
					style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
					children: "手机通道桥：把公网 relay 的流量转发到本机 dsh，手机在外网也能操作。"
				});
			}
			// form 可缺席（owner 的 describe 拿不到本条目 schema 时传 undefined）——
			// 绝不能让组件抛错，否则插件管理页整块渲染空白（实锤症状：「配置是空的」）。
			if (!form) {
				return jsx("div", {
					style: { maxWidth: 460, padding: "8px 4px", fontSize: 13, lineHeight: 1.8, color: "var(--dsw-alias-label-secondary)" },
					children: "宿主未提供配置表单：条目未激活，或 Config schema 未被识别（表单按 volatile 字段投影）。请重启 dsh 后重新打开本页；仍空白请查 $DSH_HOME/mobile-bridge-applied.log。"
				});
			}
			return jsx(RowConfigForm, { form });
		}

		function RowConfigForm({ form }) {
			const state = form.state;
			const value = state.value ?? {};
			const [draft, setDraft] = react.useState(() => {
				const out = {};
				for (const f of FIELDS) out[f.key] = String(value[f.key] ?? "");
				return out;
			});
			const [msg, setMsg] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const stat = useBridgeStatus();
			const [invite, setInvite] = react.useState(null);
			const [inviteBusy, setInviteBusy] = react.useState(false);
			const [inviteMsg, setInviteMsg] = react.useState("");
			const [lanQr, setLanQr] = react.useState(null);
			const [lanBusy, setLanBusy] = react.useState(false);
			const [lanMsg, setLanMsg] = react.useState("");
			const [lanCode, setLanCode] = react.useState(() => {
				try {
					return new URLSearchParams(window.location.search).get("token") || "";
				} catch {
					return "";
				}
			});
			// Host 值变化（本页保存成功 / 其他端修改）→ 以 revision 为 key 重挂内层表单，
			// 未保存草稿让位于 Host 最新值（与官方行配置页「离开页面丢弃暂存」一致）。
			const inner = jsx(FieldsEditor, { form, stat, draft, setDraft, msg, setMsg, busy, setBusy,
				invite, inviteBusy, inviteMsg, lanQr, lanBusy, lanMsg, lanCode, setLanCode });
			return state.status === "ready"
				? jsx("div", { key: String(state.revision ?? ""), children: inner })
				: jsx("div", {
					style: { maxWidth: 460, padding: "8px 4px", fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
					children: state.status === "loading" ? "配置读取中…" : "该行配置当前不可编辑（未暴露或连接为 memory 模式）。"
				});
		}

		function FieldsEditor({ form, stat, draft, setDraft, msg, setMsg, busy, setBusy,
			invite, inviteBusy, inviteMsg, lanQr, lanBusy, lanMsg, lanCode, setLanCode }) {
			const state = form.state;
			const value = state.value ?? {};
			const writable = state.writable !== false;
			const dirty = FIELDS.some((f) => draft[f.key] !== String(value[f.key] ?? ""));
			const save = async () => {
				setBusy(true);
				setMsg("保存中…");
				try {
					const ops = FIELDS
						.filter((f) => draft[f.key] !== String(value[f.key] ?? ""))
						.map((f) => ({ op: "set", path: [f.key], value: draft[f.key] }));
					if (!ops.length) {
						setMsg("没有改动");
						return;
					}
					const ok = await form.mutate(ops, state.revision);
					setMsg(ok ? "已保存，桥热重启生效 ✓" : "保存被拒绝（修订过期或写入被上层 patch 覆盖）");
				} catch (e) {
					setMsg(`保存失败：${(e && e.message) || e}`);
				} finally {
					setBusy(false);
				}
			};
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
			const doLanQr = async () => {
				setLanBusy(true);
				setLanMsg("生成中…");
				setLanQr(null);
				try {
					const res = await fetch(`/mobile-bridge/lan-qr?code=${encodeURIComponent(lanCode)}&name=${encodeURIComponent(window.location.hostname || "")}`);
					const j = await res.json();
					if (j.code !== 200) throw new Error(j.message || "生成失败");
					setLanQr(j.result);
					setLanMsg("");
				} catch (e) {
					setLanMsg(`生成失败：${(e && e.message) || e}`);
				} finally {
					setLanBusy(false);
				}
			};
			const row = (f) => jsxs("div", {
				style: { marginBottom: 14 },
				children: [
					jsxs("div", {
						style: labelStyle,
						children: [f.label, jsx("span", {
							style: { marginLeft: 8, color: "var(--dsw-alias-link)" },
							children: draft[f.key] !== String(value[f.key] ?? "") ? "（未保存）" : ""
						})]
					}),
					jsx("input", {
						style: inputStyle,
						value: draft[f.key],
						placeholder: f.placeholder,
						disabled: !writable,
						spellCheck: false,
						onChange: (e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))
					}),
					jsx("div", { style: hintStyle, children: f.hint })
				]
			});
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
							"手机 App 选「云端转发」，填同一 relay 地址与配对码即可直连。",
							writable ? null : jsx("div", { style: { color: "#c0392b", marginTop: 6 }, children: "当前 profile 只读（memory 模式或被 home patch / overlay 覆盖），保存已禁用。" })
						]
					}),
					FIELDS.map((f) => jsx("div", { key: f.key, children: row(f) })),
					jsxs("div", {
						style: { display: "flex", alignItems: "center", gap: 12, marginTop: 16 },
						children: [
							jsxs("button", {
								style: { ...buttonStyle, opacity: busy || !dirty || !writable ? 0.5 : 1 },
								disabled: busy || !dirty || !writable,
								onClick: save,
								children: ["保存并生效"]
							}),
							jsx("span", {
								style: { fontSize: 12, color: msg.startsWith("保存失败") || msg.includes("被拒绝") ? "#c0392b" : "var(--dsw-alias-label-secondary)" },
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
						style: { marginTop: 20, paddingTop: 12, borderTop: "1px solid var(--dsw-alias-bg-layer-3)" },
						children: [
							jsx("div", { style: labelStyle, children: "局域网直连二维码" }),
							jsx("div", {
								style: hintStyle,
								children: "同一 Wi-Fi 下手机免 relay 直连本机 dsh（dshlan:// 出码）；安全码即 launch token（留空=信任栅栏放行场景）。"
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
								children: [
									jsx("input", {
										style: { ...inputStyle, width: 220 },
										value: lanCode,
										placeholder: "安全码（launch token，可空）",
										spellCheck: false,
										onChange: (e) => setLanCode(e.target.value)
									}),
									jsxs("button", {
										style: { ...buttonStyle, opacity: lanBusy ? 0.5 : 1 },
										disabled: lanBusy,
										onClick: doLanQr,
										children: ["生成直连二维码"]
									}),
									jsx("span", { style: { fontSize: 12, color: "#c0392b" }, children: lanMsg })
								]
							}),
							lanQr ? jsxs("div", {
								style: { marginTop: 12, display: "flex", gap: 16, alignItems: "flex-start" },
								children: [
									jsx("img", {
										src: lanQr.qr,
										alt: "lan qr",
										style: { width: 180, height: 180, border: "1px solid var(--dsw-alias-bg-layer-3)", borderRadius: 6, background: "#fff" }
									}),
									jsxs("div", { style: { fontSize: 12, lineHeight: 1.9, wordBreak: "break-all" }, children: [
										jsxs("div", { children: ["地址：", jsx("b", { children: `${lanQr.host}:${lanQr.port}` })] }),
										jsxs("div", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: ["payload：", lanQr.payload] })
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
							jsxs("div", { children: ["同步：", state.mode === "host" ? "Host 文档（改动持久化到 profile patch）" : "内存模式（改动不落盘）"] }),
							jsxs("div", { children: ["修订：", String(state.revision ?? "—")] }),
							jsx("div", { children: "保存即写回本行 config（volatile 字段），桥热重启；字段清除回落环境变量 / $DSH_HOME/mobile-bridge.json。" })
						]
					})
				]
			});
		}

		/** 必需服务：slots（插件管理页槽位）。 */
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: ROW_KEY
			}, RowConfigPage));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
