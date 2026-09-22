# dsh-plugin-mobile-bridge

DSH 手机通道桌面桥插件：把 `relay/bridge.mjs` 的转发逻辑做成 dsh profile
插件（npm bundle），**随 dsh 启停自动挂载**，不再手动开脚本。

    relay(公网) ←─ WS(dsh-relay-v1) ─→ 本桥(dsh 内) ─→ http://127.0.0.1:3080

## 装进 profile（激活 = 两步）

```powershell
# 0) 先确认 dsh 实际跑的 profile！（改错 profile = 没人 watch，像"热重载坏了"）
#    Get-CimInstance Win32_Process -Filter "Name='node.exe'" 看 --profile <name>
#    DeepSeek Harness Desktop = tauri；dsh web = web
# 1) 装依赖（⚠️ 跨盘符坑见下）
dsh plugin --profile <name> add link:<同盘 junction 或插件目录>

# 2) 激活：在该 profile 的 cordis.patch.yml 加 insert（与琥珀主题同机制）
#    C:\Users\<you>\.dsh\profiles\<name>\cordis.patch.yml
# - insert:
#     - id: mobile-bridge
#       name: dsh-plugin-mobile-bridge
```

- **改对该 profile 的 `cordis.patch.yml` 后 `patchReload: live` 即时热挂载**
  （实测免重启生效：插入后数秒插件 apply、桥连上 relay）；
- ⚠️ **跨盘符坑**：pnpm 对 `link:`/`file:` 目标会归一为相对路径，跨盘符
  （如源码在 D:、profile 在 C:）会拼出坏 junction。解决：在同盘建 junction
  桥接再 link（本机做法：`mklink /J C:\Users\<you>\.dsh\plugins\dsh-plugin-mobile-bridge <仓库>\relay\dsh-plugin-mobile-bridge`，
  然后 `link:C:/Users/<you>/.dsh/plugins/dsh-plugin-mobile-bridge`）。

## 界面配置（设置 →「手机通道」）

桥的三项配置在 **dsh 设置 → 手机通道** 面板里改，保存即热生效（桥立即换
配置重连，免重启）：

| 字段 | 说明 |
| --- | --- |
| Relay 地址 | 公网 relay 的 ws(s) 地址 |
| 配对码 | ≥6 位，手机端输入同一配对码；留空 = 桥停用 |
| 本机 dsh 地址 | 桥转发目标，默认 `http://127.0.0.1:3080` |

面板底部实时显示**桥状态**（`GET /mobile-bridge/status` 5s 轮询）：
relay 连接 / 手机对端在线 / 活动隧道数 / 连接时刻。

- 数据落 **Host 设置文档 `mobile-bridge` 命名空间**（`settings.register` +
  schemastery schema，宿主半监听 `settings/updated` 热重启桥）；
- 字段清除后回落到 base 组合层（= 下面的文件/环境变量兜底）；
- 浏览器半 `lib/client.js`：`__ModuleLoader__` 工厂格式，`settings.section`
  槽位 + `ctx.settingsScope.bind({namespace})` 读写。

## 配置（优先级从高到低）

1. **设置 →「手机通道」**（`mobile-bridge` 命名空间用户层，实时热生效）；
2. loader entry 的 `config` / 环境变量 `RELAY_URL` / `RELAY_CODE` / `DSH_URL`
   / `$DSH_HOME/mobile-bridge.json`（同时构成设置的 base 组合层）：

```json
{
  "relayUrl": "wss://your-vps:8787",
  "code": "<长随机配对码>",
  "dshUrl": "http://127.0.0.1:3080"
}
```

`code` 不设（或 <6 位）时桥不启动并写错误日志——装了插件不配对是安全的。

## 卸载 / 停用

**禁用（推荐，热生效）**：在 profile 的 `cordis.patch.yml` 加一段 id 定向
override（`disabled` 支持 `!!js` 表达式）：

```yaml
# 禁用开关：true = 拆桥停用（秒级生效），删本段或改 false 恢复
- id: mobile-bridge
  disabled: true
```

生效即拆桥（关连接与隧道）、状态路由与「手机通道」面板随之下线（页面刷新后）。
补丁语法：`insert` 是 push 语义；其余段按 `id` 定向覆盖 entry 字段
（`name` 可选、写了必须匹配否则跳过）。

**彻底卸载**：

```powershell
dsh plugin --profile <name> remove dsh-plugin-mobile-bridge
```

或在 profile 的 `cordis.patch.yml` 把该 insert 段删掉（live 重载即拆）。

> ⚠️ 只装了 `dsh.client` 没有 `dsh.bundle` 的包会被 dshmarket 挂 shim entry
> （id 形如 `mkt-client-<包名>`）；卸载这类包后若运行实例里还有残留 shim
> 各自起桥抢 relay，同样用上面的 `disabled: true` 按 id 拆掉，重启后自然消失。

## 独立运行（不经 dsh，调试用）

```powershell
$env:RELAY_CODE='<配对码>'; node lib/bridge.js
```

## 测试

```powershell
node test\apply-smoke.mjs            # 插件形状 + effect 生命周期
# 全链路：起 relay 与本桥后
node ..\test-client.mjs              # HTTP 通道
node ..\test-mux.mjs ws://<relay> <code> <sessionId>   # WS 隧道
```

## 实现要点

- `lib/bridge.js`：`MobileBridge` 类（协议与 relay 的 `dsh-relay-v1` 帧对齐：
  hello/welcome、http-req/res、ws-open/frame/close（`__open__` 哨兵、rid 幂等重开）、
  ping/pong、peer 离线拆隧道、指数退避单飞重连）+ `resolveConfig` 三级配置 +
  `update(config)` 换配置热重启；
- `lib/impl.js`：宿主半实现（`apply(ctx, config)`，settings 注册 + `settings/updated`
  热重载）；`lib/index.js` 是薄壳转出（入口兼容）；
- `lib/client.js`：浏览器半（设置页「手机通道」）。

## 热激活（运行实例改代码不重启的坑与解法）

loader 的 import 记忆化按 **裸包名**命中，进程存活期间同名 entry 重建只拿到
缓存旧模块；解析失败还会把模块 URL **毒化**（errored record，后续 import 一律
复抛）。已验证的绕法与终态：

1. **query 破缓存**：`import(url + '?t=' + Date.now())` ——query 变 = URL 变 =
   永远绕开记忆化与毒化。终态引导马甲 `~/.dsh/plugins/dsh-plugin-mobile-bridge-v7`
   的 `apply` 就这么动态导入仓库 `lib/impl.js`（impl 内同样带 query 导入 bridge.js）：
   **此后改服务端半 = 改仓库文件 + 补丁层摘除/重插 entry，免换包**；
2. **全新包名 = 全新解析**（无 query 可用时的替代）：马甲包需自带
   `node_modules` junction（主包 / `@deepseek-ai` / `ws`），否则 realpath 链
   解析失败又毒化一片；
3. 浏览器半的增量扫描把「无 `dsh.client` 声明」**永久缓存**（`pkgMeta`
   缓存 null）——马甲包必须**从第一次扫描起就带声明**；
4. bundle 内容变更走 client-hmr 的 `rebuilt()` 重哈希，改 `lib/client.js`
   无需重挂 entry（下次页面加载生效）；
5. `webServer` 的 handler 是 **node 风格 `(req, res)`**（不是 fetch Response）；
6. 冷启动（dsh 重启）后一切缓存清零，entry name 直接用 `dsh-plugin-mobile-bridge`
   即可，马甲包可删（补丁里的 name 一并改回）。
