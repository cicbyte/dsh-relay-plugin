// dsh-relay-plugin 浏览器半：插件管理页「行配置」页 + 桥状态 / 二维码。
//
// 契约（现行 dsh web，2026-09 起）：
//   - 注册进插件管理页的 plugins.row.config 槽位（key = <包名>#<行 id>）；
//   - 页面组件接收 { view, form }：form.state = ConfigFormSnapshot（Host 投影的
//     volatile 字段值），form.mutate(ops, revision) 提交路径编辑，宿主校验并写回
//     profile patch 本行 config，桥随 loader/volatile-update 热重启；
//   - 旧 settingsScope 服务与 settings.section 槽位已废除——声明缺失的服务会让
//     fiber 永久 PENDING（表现为「waiting for activation」）。
//
// 布局：行配置页自绘 chrome，按「连接配置 / 扫码接入 / 运行状态」三 Tab 分组。
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

		const ROW_KEY = "dsh-relay-plugin#mobile-bridge";
		const FIELDS = [
			// 「房间码」已从 UI 移除（#940）：relay 端 AUTH_MODE=code 是兼容模式
			// （启动即警告建议迁移 device），且 device 凭证 hello 不带 code。
			// schema/entry/impl 仍保留 code 字段：老 relay 用户走 env RELAY_CODE /
			// file 配置，既有已存值继续生效。
			{ key: "relayUrl", label: "Relay 地址", hint: "公网 relay 的 ws(s) 地址，如 wss://your-vps:8787", placeholder: "ws://127.0.0.1:8787" },
			{ key: "pairingCode", label: "Host 配对码", hint: "首次配对用的一次性码（管理台/环境视图生成，role=host）；配对成功后自动改用设备令牌并清空", placeholder: "XXXX-XXXX" },
			{ key: "dshUrl", label: "本机 dsh 地址", hint: "桥转发的目标，默认 http://127.0.0.1:3080", placeholder: "http://127.0.0.1:3080" },
		];
		const TABS = [
			{ key: "connect", label: "连接配置" },
			{ key: "pair", label: "扫码接入" },
			{ key: "status", label: "运行状态" },
			{ key: "downloads", label: "下载" },
		];
		// 工作模式（本机 dsh 地址预设）：桥跑在 dsh 进程内，「当前实例」= 本页面所在的
		// dsh 地址——Desktop(:19387) / web(:3080) 自动正确，消灭默认 3080 的踩坑。
		const CURRENT_ORIGIN = (() => {
			try {
				const o = window.location.origin;
				return o && /^https?:/.test(o) ? o : "";
			} catch {
				return "";
			}
		})();
		const MODES = [
			...(CURRENT_ORIGIN ? [{ key: "current", label: "当前实例（推荐）", addr: CURRENT_ORIGIN }] : []),
			{ key: "web", label: "dsh web（:3080）", addr: "http://127.0.0.1:3080" },
			{ key: "custom", label: "自定义", addr: null },
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
		// 次级/危险按钮：必须显式给主题变量样式——裸 <button> 在宿主全局样式
		// 下暗色模式里几乎不可辨（#936 用户实测「黑暗模式下按钮看不清」）
		const ghostButtonStyle = {
			padding: "5px 12px",
			fontSize: 12,
			color: "var(--dsw-alias-label-primary)",
			background: "var(--dsw-alias-bg-layer-1)",
			border: "1px solid var(--dsw-alias-bg-layer-3)",
			borderRadius: 6,
			cursor: "pointer"
		};
		const dangerButtonStyle = Object.assign({}, ghostButtonStyle, { color: "#e5735c" });
		const sectionStyle = {
			paddingTop: 12,
			marginTop: 12,
			borderTop: "1px solid var(--dsw-alias-bg-layer-3)"
		};

		function readFields(value) {
			const out = {};
			const v = value ?? {};
			for (const f of FIELDS) out[f.key] = String(v[f.key] ?? "");
			return out;
		}

		/** useBridgeStatus：/mobile-bridge/status 轮询（常态 5s；保存后 30s 内
		 *  加速 1.5s——抓住桥热重启后的重连结果，不用自己切 Tab 等待，#939）。 */
		function useBridgeStatus(burstUntil) {
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
				const period = Date.now() < (burstUntil || 0) ? 1500 : 5000;
				const timer = setInterval(tick, period);
				return () => { alive = false; clearInterval(timer); };
			}, [burstUntil]);
			return stat;
		}

		/** 拒绝码 → 人话 + 下一步动作（#939 文案动作化）。 */
		function humanReject(code) {
			const map = {
				"auth-required": "缺少凭据：在「连接配置」填房间码或 Host 配对码",
				"bad-token": "设备令牌无效：删除 %USERPROFILE%\\.dsh\\mobile-bridge.json 后重新配对",
				"unknown-device": "设备未注册：请重新配对",
				revoked: "设备已被吊销：请在管理台重新生成配对码",
				"pairing-invalid": "配对码无效：请重新生成",
				"pairing-expired": "配对码已过期（600 秒有效）：请重新生成",
				"pairing-used": "配对码已被使用：请重新生成",
				"pairing-burned": "配对码已核销：请重新生成",
				"room-mismatch": "房间不匹配：配对码与所选环境不一致",
				"role-mismatch": "角色不匹配：需要 role=host 的配对码",
				"rate-limited": "尝试过于频繁：请等约 60 秒再保存",
				"bad-hello": "握手格式异常：请核对 relay 地址与端口"
			};
			return map[code] ? `${code}——${map[code]}` : code;
		}

		/** 顶部连接状态条：所有 Tab 常驻（#939）。语义色只用于圆点，文字一律走
		 *  主题变量——暗/亮主题都可读（此前裸红/绿文字在暗色下看不清的教训）。 */
		const stripStyle = {
			display: "flex",
			alignItems: "center",
			gap: 10,
			flexWrap: "wrap",
			padding: "8px 12px",
			marginBottom: 10,
			fontSize: 12,
			border: "1px solid var(--dsw-alias-bg-layer-3)",
			borderRadius: 6,
			background: "var(--dsw-alias-bg-layer-1)"
		};
		function StatusStrip({ stat }) {
			if (!stat) {
				return jsx("div", { style: stripStyle, children: "桥状态获取中…" });
			}
			const dot = stat.connected ? "#4caf50" : stat.lastReject ? "#e5735c" : "var(--dsw-alias-label-tertiary)";
			const text = stat.connected
				? "已连 relay"
				: stat.lastReject ? `连接被拒：${humanReject(stat.lastReject)}` : "未连接 relay";
			return jsxs("div", {
				style: stripStyle,
				children: [
					jsx("span", { style: { width: 9, height: 9, borderRadius: "50%", background: dot, flex: "0 0 auto" } }),
					jsx("span", { style: { color: "var(--dsw-alias-label-primary)" }, children: text }),
					jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: stat.paired ? `已配对${stat.deviceId ? " · " + stat.deviceId : ""}` : "未配对" }),
					jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)" }, children: stat.peerOnline ? `手机 ${stat.clientCount ?? 0} 台在线` : "手机离线" })
				]
			});
		}

		/** 里程碑行（旅程清单布局）：圆点 + 标题/详情 + 动作按钮，#939。 */
		function MilestoneRow({ tone, title, detail, actionLabel, onAction }) {
			const dotColor = tone === "ok" ? "#4caf50" : tone === "bad" ? "#e5735c" : "var(--dsw-alias-label-tertiary)";
			return jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: "1px solid var(--dsw-alias-bg-layer-3)" },
				children: [
					jsx("span", { style: { width: 9, height: 9, borderRadius: "50%", background: dotColor, flex: "0 0 auto" } }),
					jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
						jsx("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" }, children: title }),
						jsx("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: detail })
					] }),
					actionLabel ? jsx("button", { style: ghostButtonStyle, onClick: onAction, children: actionLabel }) : null
				]
			});
		}

		/** dsh 地址 → 工作模式人话（#939）。 */
		function modeLabel(addr) {
			if (!addr) return "未设置（回落默认 :3080）";
			if (CURRENT_ORIGIN && addr === CURRENT_ORIGIN) return `当前实例（${addr}）`;
			if (addr === "http://127.0.0.1:3080") return "dsh web（:3080）";
			return `自定义（${addr}）`;
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

		/** 页面外壳：状态全上提（保存后 revision 变化不重置 Tab 与保存提示），面板按 Tab 分组。 */
		function RowConfigForm({ form }) {
			const state = form.state;
			const mutate = form.mutate;
			const [tab, setTab] = react.useState("connect");
			const [draft, setDraft] = react.useState(() => readFields(state.value));
			const [msg, setMsg] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			// 保存后 30s 内轮询加速窗口（1.5s），抓住桥热重启后的重连结果（#939）
			const [burstUntil, setBurstUntil] = react.useState(0);
			const onSaved = () => setBurstUntil(Date.now() + 30000);
			const stat = useBridgeStatus(burstUntil);
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
			// Host 值变化（本页保存成功 / 其他端修改）→ 草稿对齐 Host 最新值；
			// msg/Tab 不随之重置，「已保存 ✓」与当前分组保持可见。
			react.useEffect(() => {
				setDraft(readFields(state.value));
			}, [state.revision]);

			if (state.status !== "ready") {
				return jsx("div", {
					style: { maxWidth: 460, padding: "8px 4px", fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
					children: state.status === "loading" ? "配置读取中…" : "该行配置当前不可编辑（未暴露或连接为 memory 模式）。"
				});
			}

			const shared = {
				state, mutate, draft, setDraft, msg, setMsg, busy, setBusy, stat, setTab, onSaved,
				invite, setInvite, inviteBusy, setInviteBusy, inviteMsg, setInviteMsg,
				lanQr, setLanQr, lanBusy, setLanBusy, lanMsg, setLanMsg, lanCode, setLanCode
			};
			return jsxs("div", {
				style: {
					maxWidth: 520,
					padding: "8px 4px",
					fontSize: 13,
					color: "var(--dsw-alias-label-primary)"
				},
				children: [
					jsx(StatusStrip, { stat }),
					jsxs("div", {
						style: { lineHeight: 1.7, color: "var(--dsw-alias-label-secondary)", marginBottom: 8 },
						children: [
							"桌面桥随 dsh 启停，把公网 relay 的流量（HTTP/WS）转发到本机 dsh。",
							jsx("br", {}),
							"手机 App 选「云端转发」，填同一 relay 地址与配对码即可直连。"
						]
					}),
					jsx(TabBar, { tab, setTab }),
					tab === "connect" ? jsx(ConnectPanel, shared) : null,
					tab === "pair" ? jsx(PairPanel, shared) : null,
					tab === "status" ? jsx(StatusPanel, shared) : null,
					tab === "downloads" ? jsx(DownloadPanel, shared) : null
				]
			});
		}

		function TabBar({ tab, setTab }) {
			return jsx("div", {
				style: {
					display: "flex",
					gap: 2,
					borderBottom: "1px solid var(--dsw-alias-bg-layer-3)",
					marginBottom: 14
				},
				children: TABS.map((t) => {
					const active = tab === t.key;
					return jsx("button", {
						key: t.key,
						onClick: () => setTab(t.key),
						style: {
							padding: "7px 16px",
							fontSize: 13,
							fontWeight: active ? 600 : 400,
							color: active ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-label-secondary)",
							background: "transparent",
							border: "none",
							borderBottom: `2px solid ${active ? "var(--dsw-alias-brand-primary)" : "transparent"}`,
							marginBottom: -1,
							cursor: "pointer"
						},
						children: t.label
					});
				})
			});
		}

		/** 工作模式快捷选择：预设填 dshUrl，芯片高亮由字段当前值推导。
		 *  「自定义」是可点选的显式状态：此前 addr=null 点击无动作、高亮又只按
		 *  「值===预设地址」推导——值等于预设时点「自定义」毫无反馈，看起来就是
		 *  切不过去（#936 用户实测）。点它=脱离预设进入手改并聚焦输入框；
		 *  点预设芯片 / 保存后 revision 变化即退出该状态。 */
		function ModePicker({ draft, setDraft, writable, revision }) {
			const [customPick, setCustomPick] = react.useState(false);
			react.useEffect(() => { setCustomPick(false); }, [revision]);
			const preset = MODES.find((m) => m.addr !== null && m.addr === draft.dshUrl);
			const active = customPick || !preset ? "custom" : preset.key;
			const focusDshInput = () => {
				try {
					const el = document.getElementById("dsh-relay-dsh-url");
					if (el && el.focus) {
						el.focus();
						// 全选现有文本：提示「直接输入即替换」，改值后保存按钮才会亮起动作
						if (el.select) el.select();
					}
				} catch {}
			};
			return jsxs("div", {
				style: { marginBottom: 8 },
				children: [
					jsx("div", { style: labelStyle, children: "工作模式" }),
					jsx("div", {
						style: { display: "flex", gap: 6, flexWrap: "wrap" },
						children: MODES.map((m) => {
							const on = active === m.key;
							return jsx("button", {
								key: m.key,
								disabled: !writable,
								onClick: () => {
									if (!writable) return;
									if (m.addr !== null) {
										setCustomPick(false);
										setDraft((d) => ({ ...d, dshUrl: m.addr }));
									} else {
										// 「自定义」= 真实模式切换，不只是高亮（#938）：当前值是
										// 预设时清空草稿进入手填——立即算有改动、保存才落得住；
										// 已是自定义值（无预设匹配）则只聚焦，不动已填内容。
										// 保存空值 = dshUrl 未设，桥回落环境变量/文件/默认地址
										//（resolveConfig 语义），芯片高亮按值推导、跨导航持久。
										setCustomPick(true);
										if (preset) setDraft((d) => ({ ...d, dshUrl: "" }));
										focusDshInput();
									}
								},
								style: {
									padding: "4px 12px",
									fontSize: 12,
									color: on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-label-secondary)",
									background: on ? "color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)" : "var(--dsw-alias-bg-layer-1)",
									border: `1px solid ${on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-bg-layer-3)"}`,
									borderRadius: 12,
									cursor: writable ? "pointer" : "default",
									opacity: writable ? 1 : 0.5
								},
								children: m.label
							});
						})
					}),
					jsx("div", {
						style: hintStyle,
						children: `桥转发到本机 dsh 的地址。当前页面所在实例：${CURRENT_ORIGIN || "未知"}；「当前实例」一键取它（Desktop :19387 / web :3080 均适配）；「自定义」点选后输入框清空，填入目标地址再保存（留空保存=回落默认地址）。`
					})
				]
			});
		}

		/** Tab 1：连接配置——旅程清单（① 云端 relay → ② 本机 dsh → ③ 手机接入），
		 *  点击里程碑展开对应编辑区；不再四字段平铺（#939）。 */
		function ConnectPanel({ state, mutate, draft, setDraft, msg, setMsg, busy, setBusy, stat, setTab, onSaved }) {
			const value = state.value ?? {};
			const writable = state.writable !== false;
			const dirty = FIELDS.some((f) => draft[f.key] !== String(value[f.key] ?? ""));
			const relayOn = !!(stat && stat.connected);
			const paired = !!(stat && stat.paired);
			// 首次使用（relay 地址为空）默认展开第①步；已配置的机器清单收起
			const [openSec, setOpenSec] = react.useState(() => (String(value.relayUrl ?? "") === "" ? "relay" : null));
			const save = async () => {
				setBusy(true);
				setMsg("保存中…");
				try {
					const ops = FIELDS
						.filter((f) => draft[f.key] !== String(value[f.key] ?? ""))
						.map((f) => ({ op: "set", path: [f.key], value: draft[f.key] }));
					if (!ops.length) {
						// 无改动不再禁用按钮（禁用态半透明在暗色下像「看不清+点不动」，
						// #937）：恒可点，点了给明确反馈
						setMsg("没有改动：请先修改要保存的字段（如「本机 dsh 地址」）");
						return;
					}
					const ok = await mutate(ops, state.revision);
					setMsg(ok ? "已保存，桥热重启，正在重连…" : "保存被拒绝（修订过期或写入被上层 patch 覆盖）");
					if (ok && onSaved) onSaved(); // 30s 加速轮询，就地看重连结果（#939）
				} catch (e) {
					setMsg(`保存失败：${(e && e.message) || e}`);
				} finally {
					setBusy(false);
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
						id: f.key === "dshUrl" ? "dsh-relay-dsh-url" : undefined,
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
			const editBoxStyle = {
				border: "1px solid var(--dsw-alias-bg-layer-3)",
				borderRadius: 6,
				padding: "10px 12px",
				marginBottom: 4,
				background: "var(--dsw-alias-bg-layer-1)"
			};
			// 保存区（relay / dsh 两个编辑区共用，同时只展开一个）
			const saveRow = jsxs("div", {
				style: { display: "flex", alignItems: "center", gap: 12, marginTop: 4, flexWrap: "wrap" },
				children: [
					jsxs("button", {
						// 可写时恒可点（去掉 !dirty 禁用：无改动点击有明确提示），
						// 只有 busy 才降透明度——按钮不再「半透明像坏了」（#937）
						style: {
							...buttonStyle,
							border: "1px solid color-mix(in srgb, #fff 25%, transparent)",
							opacity: busy ? 0.55 : 1,
							cursor: busy || !writable ? "default" : "pointer"
						},
						disabled: busy || !writable,
						onClick: save,
						children: [writable ? "保存并生效" : "只读，不可保存"]
					}),
					writable && !dirty ? jsx("span", {
						style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)" },
						children: "当前无改动"
					}) : null,
					jsx("span", {
						style: { fontSize: 12, color: msg.startsWith("保存失败") || msg.includes("被拒绝") ? "#e5735c" : "var(--dsw-alias-label-secondary)" },
						children: msg
					})
				]
			});
			return jsxs("div", {
				children: [
					writable ? null : jsx("div", {
						// 只读警告用描边芯片而非裸红字：#c0392b 在暗色背景上同样看不清（#937）
						style: {
							color: "#e5735c",
							background: "color-mix(in srgb, #e5735c 10%, transparent)",
							border: "1px solid #e5735c",
							borderRadius: 6,
							padding: "8px 12px",
							marginBottom: 12,
							fontSize: 12,
							lineHeight: 1.7
						},
						children: "当前 profile 只读（memory 模式或被 home patch / overlay 覆盖），保存已禁用。"
					}),
					jsx(MilestoneRow, {
						tone: relayOn ? "ok" : (stat && stat.lastReject) ? "bad" : "idle",
						title: relayOn ? "① 云端 relay：已连接" : (stat && stat.lastReject) ? "① 云端 relay：被拒" : "① 云端 relay：未连接",
						detail: relayOn
							? (stat.relayUrl || "")
							: (stat && stat.lastReject)
								? humanReject(stat.lastReject)
								: (draft.relayUrl ? `已填 ${draft.relayUrl}，保存后自动连接` : "填写 relay 地址，保存后自动连接"),
						actionLabel: openSec === "relay" ? "收起" : "填写 / 修改",
						onAction: () => setOpenSec(openSec === "relay" ? null : "relay")
					}),
					openSec === "relay" ? jsxs("div", { style: editBoxStyle, children: [
						row(FIELDS[0]),
						jsxs("div", { style: { marginBottom: 14 }, children: [
							jsx("div", { style: labelStyle, children: "Host 配对码" }),
							jsx("input", {
								style: inputStyle,
								value: draft.pairingCode,
								placeholder: FIELDS[1].placeholder,
								disabled: !writable,
								spellCheck: false,
								onChange: (e) => setDraft((d) => ({ ...d, pairingCode: e.target.value }))
							}),
							jsx("div", { style: hintStyle, children: FIELDS[1].hint })
						] }),
						saveRow
					] }) : null,
					jsx(MilestoneRow, {
						tone: "ok",
						title: "② 本机 dsh：转发目标",
						detail: modeLabel(draft.dshUrl),
						actionLabel: openSec === "dsh" ? "收起" : "修改",
						onAction: () => setOpenSec(openSec === "dsh" ? null : "dsh")
					}),
					openSec === "dsh" ? jsxs("div", { style: editBoxStyle, children: [
						jsx(ModePicker, { draft, setDraft, writable, revision: state.revision }),
						row(FIELDS[2]),
						saveRow
					] }) : null,
					jsx(MilestoneRow, {
						tone: paired ? "ok" : "idle",
						title: paired ? "③ 手机接入：已配对" : "③ 手机接入：未配对",
						detail: paired
							? `${stat.deviceId || ""}${stat.peerOnline ? " · 手机在线" : " · 手机离线"}`
							: "在「扫码接入」生成配对码，手机扫码一键接入",
						actionLabel: "去扫码 →",
						onAction: () => setTab("pair")
					}),
					jsx("div", {
						style: { ...hintStyle, marginTop: 12, lineHeight: 1.8 },
						children: "保存即写回本行 config（volatile 字段），桥热重启并自动重连；保存后本页会加速刷新连接状态。字段清除回落环境变量 / $DSH_HOME/mobile-bridge.json。"
					})
				]
			});
		}

		/** Tab 2：扫码接入——手机配对二维码 + 局域网直连二维码。 */
		function PairPanel({ stat, invite, setInvite, inviteBusy, setInviteBusy, inviteMsg, setInviteMsg,
			lanQr, setLanQr, lanBusy, setLanBusy, lanMsg, setLanMsg, lanCode, setLanCode }) {
			// 安全码默认取本机 launch token（服务端环回限定路由），不再依赖页面 URL 预填；
			// 用户已填/清空的值不覆盖。
			react.useEffect(() => {
				(async () => {
					try {
						const res = await fetch("/mobile-bridge/launch-token");
						const j = await res.json();
						if (j && j.code === 200 && j.result && j.result.token) {
							setLanCode((cur) => cur || j.result.token);
						}
					} catch {}
				})();
			}, []);
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
			return jsxs("div", {
				children: [
					jsxs("div", {
						children: [
							jsx("div", { style: labelStyle, children: "手机连接二维码" }),
							// 主 CTA：relay 已连且已配对 → 大主按钮；未就绪 → 引导先完成①②（#939）
							jsx("div", {
								style: hintStyle,
								children: (stat && stat.connected && stat.paired)
									? "生成一次性配对码二维码，手机扫码即自动接入本环境（免管理台，600 秒有效）。"
									: "先在「连接配置」完成 ① 云端 relay 连接与配对，再回来生成手机配对码。"
							}),
							jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: 12, marginTop: 8, flexWrap: "wrap" },
								children: [
									jsxs("button", {
										style: (stat && stat.connected && stat.paired)
											? { ...buttonStyle, padding: "10px 24px", fontSize: 14, border: "1px solid color-mix(in srgb, #fff 25%, transparent)" }
											: { ...ghostButtonStyle, opacity: 0.6, cursor: "default" },
										disabled: inviteBusy || !(stat && stat.connected && stat.paired),
										onClick: doInvite,
										children: ["生成手机配对码"]
									}),
									jsx("span", { style: { fontSize: 12, color: "#e5735c" }, children: inviteMsg })
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
										// 不展示 payload 原文：room hex 易被误认成第二个要填的码（#942 同源
										// 处理）。二维码仍编码完整 payload；环境随配对码自动绑定，无需手填
										jsx("div", { style: hintStyle, children: "600 秒内有效，仅可使用一次。手机扫码，或手动输入配对码（环境随码自动绑定，无需手填房间）。" })
									]})
								]
							}) : null
						]
					}),
					jsxs("div", {
						style: sectionStyle,
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
									jsx("span", { style: { fontSize: 12, color: "#e5735c" }, children: lanMsg })
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
					})
				]
			});
		}

		/** Tab 3：运行状态——桥状态 + 同步/修订信息。 */
		function StatusPanel({ state, stat }) {
			return jsxs("div", {
				style: {
					fontSize: 12,
					color: "var(--dsw-alias-label-tertiary)",
					lineHeight: 1.9
				},
				children: [
					jsxs("div", {
						children: [
							"桥状态：",
							stat
								? jsxs("span", {
									style: { color: stat.connected ? "#4caf50" : "#e5735c" },
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
					jsxs("div", { children: ["可写：", state.writable !== false ? "是" : "否（只读镜像）"] }),
					// 「房间码」行已移除（#940）：设备配对是唯一主路径；旧 code 模式
					// 仅经 env RELAY_CODE / file 配置，页面不再展示
					jsxs("div", { children: ["设备令牌：", stat && stat.paired ? `已配对（${stat.deviceId || "dev"}），重连免配对` : "未配对（首次保存 Host 配对码后自动换取）"] })
				]
			});
		}

		/** Tab 4：下载——管理附件下载链接（查看剩余有效期 / 复制路径 / 撤销）。 */
		function DownloadPanel() {
			const [items, setItems] = react.useState(null);
			const [msg, setMsg] = react.useState("");
			const load = react.useCallback(async () => {
				try {
					const r = await fetch("/mobile-bridge/dl-list", { credentials: "same-origin" });
					const j = await r.json();
					setItems(j.code === 200 ? (j.result?.items ?? []) : []);
					if (j.code !== 200) setMsg(j.message || "读取失败");
				} catch (e) {
					setItems([]);
					setMsg(String(e?.message || e));
				}
			}, []);
			react.useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);
			const revoke = async (id) => {
				try {
					await fetch("/mobile-bridge/dl-revoke", {
						method: "POST", credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ downloadId: id })
					});
					load();
				} catch (e) { setMsg(String(e?.message || e)); }
			};
			const copy = (id) => {
				const url = `/mobile-bridge/dl/${id}`;
				navigator.clipboard?.writeText(url);
				setMsg("已复制下载路径");
			};
			const fmtLeft = (exp) => {
				const s = Math.max(0, Math.floor((exp - Date.now()) / 1000));
				if (s < 60) return `${s}s`;
				if (s < 3600) return `${Math.floor(s / 60)}m`;
				return `${Math.floor(s / 3600)}h`;
			};
			return jsxs("div", {
				style: { padding: "12px 0", fontSize: 13 },
				children: [
					msg ? jsxs("div", { style: { color: "#d9a441", marginBottom: 8 }, children: [msg] }) : null,
					!items ? jsxs("div", { children: ["加载中…"] })
						: items.length === 0 ? jsxs("div", { style: { opacity: .7 }, children: ["暂无有效下载链接。手机端会话页「下载附件」生成。"] })
							: items.map((it) => jsxs("div", {
								style: { display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--dsw-alias-bg-layer-3)" },
								children: [
									jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [
										jsxs("div", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, children: [it.name] }),
										jsxs("div", { style: { opacity: .6, fontSize: 11 }, children: [it.deviceId || "未绑设备", " · 剩 ", fmtLeft(it.expiresAt)] })
									] }),
									jsx("button", { onClick: () => copy(it.downloadId), style: ghostButtonStyle, children: "复制" }),
									jsx("button", { onClick: () => revoke(it.downloadId), style: dangerButtonStyle, children: "撤销" })
								]
							}))
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
