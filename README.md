# dsh-relay-plugin

**简体中文** | [English](README.en.md)

> DSH 手机通道桥插件：装进 dsh profile 随其启停自动挂载，把 relay 流量（HTTP/WS）转发到本机 dsh web —— 手机在外网也能安全操作家里的 dsh。

> npm 包名与仓库名一致；装进 profile 时 `insert` 的 `name:` 填 `dsh-relay-plugin`（`id` 仍可任意，示例沿用 `mobile-bridge`）。

```
手机 App ──云端模式──▶ relay（公网 VPS）──WS dsh-relay-v1──▶ 本插件（dsh 进程内）──▶ http://127.0.0.1:3080（本机 dsh web）
   └──────局域网模式（不经 relay）：同 Wi-Fi 直达 dsh web，dshlan:// 扫码即建环境
```

| 仓库 | 职责 |
|---|---|
| 本仓库 **dsh-relay-plugin** | 桥插件（Node.js cordis bundle，跑在 dsh 进程内） |
| [dsh-relay-service](https://github.com/cicbyte/dsh-relay-service) | relay 服务端（Rust，公网 VPS）+ 协议设计与全链路测试 |
| [dsh-relay-mobile](https://github.com/cicbyte/dsh-relay-mobile) | 手机端（Flutter，「云端转发 / 局域网直连」两种模式） |

## 功能特性

- **随 dsh 启停自动挂载** — cordis bundle 插件（声明 `dsh.bundle` 自带挂载补丁，`dsh plugin add` 即激活），`patchReload: live` 热挂载免重启，不再手动开脚本；
- **插件页可视配置** — dsh 设置 → 插件 → 本包行的「配置」：volatile 字段（Relay 地址 / 配对码 / 本机 dsh 地址）保存即写回本行 config，桥热重启生效；字段清除后回落文件/环境变量兜底；
- **双通道扫码接入** — 云端：桥用设备令牌代领一次性配对码出 `dshrelay://` 二维码（免管理台，家人扫码即接入）；局域网：`dshlan://` 直连二维码（安全码 = web launch token）；
- **附件下载池（.dsh-download）** — 手机只能下载「下载池」内文件：工作区池 `<会话cwd>/.dsh-download` + 全局池 `$DSH_HOME/.dsh-download`；磁盘任意文件须先「添加入池」（`dl-stage` 复制，原文件保留）才能建链接，`dl-create` 对池外路径一律 403（安全边界在桥端，绕过手机 UI 也下不了任意文件）；池内文件支持 `dl-pool` 列表 / `dl-pool-delete` 删除；
- **断线续传（协议 v3）** — relay 断线不拆本地隧道，出站帧进队列，重连后从断点回放无缝续流；同刻小帧合并 `batch` 信封零额外延迟；
- **自愈重连** — 收到 `welcome` 才重置退避；凭据类拒绝与限流走 ≥30s 长退避并尊重服务端 `retryAfterSecs`，杜绝重连风暴；
- **安全转发** — 只透传 `cookie` / `content-type` / `accept` / `authorization` / `range`（下载断点续传）五个头，Host 固定 loopback 过 dsh 信任栅栏；配对码 <6 位桥不启动（装了不配对是安全的）。

## 目录

- [装进 profile（激活 = 一步）](#装进-profile激活--一步)
- [手机端接入](#手机端接入)
- [配置](#配置优先级从高到低)
- [配对与设备凭据（协议 v2）](#配对与设备凭据协议-v2)
- [卸载 / 停用](#卸载--停用)
- [独立运行（不经 dsh）](#独立运行不经-dsh)
- [测试](#测试)
- [实现要点](#实现要点)

## 装进 profile（激活 = 一步）

```powershell
# 0) 先确认 dsh 实际跑的 profile！（改错 profile = 没人 watch，像"热重载坏了"）
#    Get-CimInstance Win32_Process -Filter "Name='node.exe'" 看 --profile <name>
#    DeepSeek Harness Desktop = tauri；dsh web = web
# 1) 装包即激活：包声明了 dsh.bundle（自带 cordis.patch.yml 挂 mobile-bridge entry），
#    profile 组装器自动应用补丁，随 dsh 启停挂载；补丁变更 patchReload: live 热挂载
dsh plugin --profile <name> add link:<同盘 junction 或插件目录>
```

- ⚠️ **别重复挂**：早先手工在 profile 的 `cordis.patch.yml` 写过 insert 的，装本包后把那段删掉——bundle 自带同一段 insert，同 id 双份会挂出两个 entry 抢 relay；
- ⚠️ **跨盘符坑**：pnpm 对 `link:` / `file:` 目标会归一为相对路径，跨盘符（如源码在 D:、profile 在 C:）会拼出坏 junction。解决：在同盘建 junction 再 link：

```powershell
mklink /J C:\Users\<you>\.dsh\plugins\dsh-relay-plugin D:\code\cicbyte\dsh-mobile\dsh-relay\dsh-relay-plugin
# 然后 dsh plugin --profile <name> add link:C:/Users/<you>/.dsh/plugins/dsh-relay-plugin
```

## 手机端接入

| 模式 | 操作 | 二维码协议 |
|---|---|---|
| 云端转发 | 桥完成配对后，插件行配置页「手机连接二维码」→ 手机 App（云端转发）扫码，自动建转发环境并配对 | `dshrelay://<relay-host>/?pair=<一次性码>&room=<房间>&name=<名>` |
| 局域网直连 | 插件行配置页「局域网直连」卡 → 出码 → 手机 App 扫码直达本机 dsh web（不经 relay） | `dshlan://<局域网IP>:<dshPort>/?code=<launch token>&name=<电脑名>` |

两个入口都由本插件的 dsh web 路由供码：`GET /mobile-bridge/status`（状态，行配置页 5s 轮询：relay 连接 / 手机在线 / 活动隧道数 / 连接时刻）、`POST /mobile-bridge/invite`（代领配对码）、`GET /mobile-bridge/lan-qr`（局域网出码）。

附件下载走下载池路由：`GET /mobile-bridge/dl-pool?workspace=<会话cwd>`（池列表：工作区池 + 全局池）、`POST /mobile-bridge/dl-stage`（任意磁盘文件复制入池）、`POST /mobile-bridge/dl-create`（池内文件建设备绑定链接）、`POST /mobile-bridge/dl-pool-delete`（删池内副本）、`GET /mobile-bridge/dl/<id>`（流式下载 + Range）、`GET /mobile-bridge/dl-list` / `POST /mobile-bridge/dl-revoke`（链接管理）。

## 配置（优先级从高到低）

1. **设置 → 插件 → 本包行的「配置」**（行 config 的 volatile 字段，保存经 ConfigEditor 写回 profile patch，`loader/volatile-update` 通知桥热重启；字段清除回落兜底层）；「工作模式」快捷选择（当前实例 / dsh web :3080 / 自定义）一键定位本机 dsh 地址；
2. **环境变量 / `$DSH_HOME/mobile-bridge.json`**（行 config 未设字段的兜底）：

```json
{
  "relayUrl": "wss://your-vps:8787",
  "code": "<长随机配对码>",
  "dshUrl": "http://127.0.0.1:3080"
}
```

全部字段（`resolveConfig`）：

| 字段 | 环境变量 | 缺省 | 说明 |
|---|---|---|---|
| `relayUrl` | `RELAY_URL` | `ws://127.0.0.1:8787` | relay 的 ws(s) 地址 |
| `code` | `RELAY_CODE` | （空） | 共享配对码（code 模式）；<6 位桥不启动 |
| `dshUrl` | `DSH_URL` | `http://127.0.0.1:3080` | 本机 dsh web 地址 |
| `pairingCode` | `RELAY_PAIRING_CODE` | （空） | 一次性 host 配对码（首次配对用，成功即作废） |
| `deviceId` / `token` | `RELAY_DEVICE_ID` / `RELAY_DEVICE_TOKEN` | 配对后自动落盘 | 设备凭据（hello v2 令牌重连） |
| `name` | `RELAY_DEVICE_NAME` | `bridge-<主机名>` | 设备名 |
| `adminUrl` | `RELAY_ADMIN_URL` | 由 `relayUrl` 推导（`:8787`→`:8788`） | 管理面地址（代领配对码用） |

## 配对与设备凭据（协议 v2）

1. **首次配对**：管理台/环境视图生成 role=host 一次性配对码 → 填入设置页或 `RELAY_PAIRING_CODE`；
2. 握手成功（`welcome`）携带 `device{id, token}` → **自动落盘** `$DSH_HOME/mobile-bridge.json`，此后走令牌重连（一次性码作废）；
3. **被吊销**：收到 `bye revoked` 后慢速自愈（≥30s 退避），在管理台重新生成配对码或轮换令牌；
4. **代领配对码**：桥已配对后可用自身设备令牌向管理面 `POST /api/invite` 签发 role=client 配对码——设置页二维码就是走这条路，免登管理台。

> 设备凭据模式下 hello **不带 `code`**（服务端把 code 哈希当房间主张，带 room-id 当 code 会误报 room-mismatch）；`code` 仅旧共享码模式（`AUTH_MODE=code`）使用。

## 卸载 / 停用

**禁用（推荐，热生效）**：在 profile 的 `cordis.patch.yml` 加一段 id 定向 override（`disabled` 支持 `!!js` 表达式）：

```yaml
# 禁用开关：true = 拆桥停用（秒级生效），删本段或改 false 恢复
- id: mobile-bridge
  disabled: true
```

生效即拆桥（关连接与隧道）、状态路由与行配置页随之下线（页面刷新后）。补丁语法：`insert` 是 push 语义；其余段按 `id` 定向覆盖 entry 字段（`name` 可选、写了必须匹配否则跳过）。

**彻底卸载**：

```powershell
dsh plugin --profile <name> remove dsh-relay-plugin
```

或在 profile 的 `cordis.patch.yml` 把该 insert 段删掉（live 重载即拆）。

> ⚠️ 只装了 `dsh.client` 没有 `dsh.bundle` 的包会被 dshmarket 挂 shim entry（id 形如 `mkt-client-<包名>`）；卸载这类包后若运行实例里还有残留 shim 各自起桥抢 relay，同样用上面的 `disabled: true` 按 id 拆掉，重启后自然消失。

## 独立运行（不经 dsh）

```powershell
# 首次：管理台生成 host 配对码
$env:RELAY_URL='wss://your-vps:8787'; $env:RELAY_PAIRING_CODE='XXXX-XXXX'; node tools/standalone.mjs
# 配对成功后凭据已落盘，直接跑
node tools/standalone.mjs
# 可选：BRIDGE_DEBUG=1 调试日志；BRIDGE_CONFIG=<路径> 换配置文件
```

`node lib/bridge.js`（只认 `RELAY_CODE` 共享码）也可用，推荐 `tools/standalone.mjs`（SIGTERM 处理 + 启动配置打印）。

## 测试

```powershell
node test\apply-smoke.mjs        # 插件形状 + settings 注册 + 热重载 + disposer 关闭
node test\download-smoke.mjs     # 下载池模型：池外 403 + 入池复制 + 池列表/删除 + 设备绑定 + Range
node test\lan-qr.mjs             # dshlan:// 出码逻辑
node test\workspace-smoke.mjs    # workspace-roots + workspace-list 跨平台

# 全链路（relay 起来后，工具在 dsh-relay-service 仓库）
node ..\dsh-relay-service\test\test-client.mjs                              # HTTP 通道
node ..\dsh-relay-service\test\test-mux.mjs ws://<relay> <code> <sessionId> # WS 隧道
```

## 实现要点

| 文件 | 职责 |
|---|---|
| `lib/bridge.js` | `MobileBridge` 核心：`dsh-relay-v1` 帧对齐 relay（hello/welcome、http-req/res、ws-open/frame/close（`__open__` 哨兵、rid 幂等重开）、ping/pong、batch/resume、peer 离线拆隧道）+ `resolveConfig` 三级配置 + `update(config)` 换配置热重启 + 独立入口 |
| `lib/impl.js` | 宿主半：`apply(ctx, config)`——Config schema（volatile 字段）+ `loader/volatile-update` 热重启 + `/mobile-bridge/*` 路由（status / invite / lan-qr / workspace / 下载池 dl-*） |
| `lib/client.js` | 浏览器半：插件管理页「行配置」页（`plugins.row.config` 槽位，`{ view, form }` 驱动 volatile 表单） |
| `lib/index.js` | 薄壳转出（入口兼容） |
| `tools/standalone.mjs` | 独立运行入口（不经 dsh 插件宿主） |

**协议演进**：v1 共享配对码 + 指数退避重连 → v2 设备身份（令牌优先 / 一次性配对码首配 / 凭据落盘 / 代领配对码）→ v3 断线续传（`resumeFrom` 断点 + 出站队列 + `batch` 合并展开）+ 限流长退避。

**运行实例热更代码的坑**（loader 的 import 记忆化按 URL 命中，解析失败还会毒化模块图）：

- 改宿主半转发逻辑：`impl.js` 内部对 `bridge.js` 用 `?t=` query 破缓存动态导入——改 `lib/bridge.js` 后补丁层摘除/重插 entry 即生效，免换包；
- 改 `lib/client.js`：免重挂 entry（client-hmr `rebuilt()` 重哈希，下次页面加载生效）；
- `webServer` 的 handler 是 **node 风格 `(req, res)`**（不是 fetch Response）；
- 冷启动后缓存清零，entry name 直接用 `dsh-relay-plugin` 即可。

## 开源许可证

[MIT](LICENSE) © cicbyte
