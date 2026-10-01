// dsh-relay-plugin 宿主半实现：桌面桥 + /mobile-bridge/* 路由。
//
// 配置契约（现行 dsh，2026-09 起）：本行 Config schema 的 volatile 字段 = 插件管理页
// 「行配置」表单的数据源；保存经 ConfigEditor 写回 profile patch 本行 config，宿主以
// loader/volatile-update 通知本插件，桥按新配置热重启（免重启进程）。
// 兜底（优先级低于行 config）：环境变量 RELAY_* / $DSH_HOME/mobile-bridge.json。
// 旧 settings.register 命名空间契约已废除（现行 ctx.settings 无 register）。
//
// 插件形状：导出 apply(ctx, config)。生命周期：随 fiber 起停——apply 内启动桥，
// ctx.effect 注册的 disposer 在 entry 被 disable/移除/进程退出时关闭全部连接。

import { appendFileSync, readdirSync, statSync, existsSync, readdir, createReadStream, unlinkSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import z from '@deepseek-ai/schemastery';

// bridge 带 query 破缓存地动态导入：loader 的模块图按 URL 记忆/毒化，
// 热激活路径每次 apply 都拿全新桥模块（冷启动无害，多一份实例而已）。
const { MobileBridge, resolveConfig, lanAddress } = await import(`./bridge.js?t=${Date.now()}`);

/** 行配置 schema：volatile 字段即插件管理页行配置表单的字段（保存即热生效）。 */
export const Config = z.object({
  relayUrl: z.string().default('ws://127.0.0.1:8787').volatile(),
  code: z.string().default('').volatile(),
  dshUrl: z.string().default('http://127.0.0.1:3080').volatile(),
  pairingCode: z.string().default('').volatile(),
  // 快速工作区路径（逗号分隔）：手机端「新建会话」快速选择区置顶展示，免逐层浏览。
  workspacePaths: z.string().default('').volatile(),
});

// 落地痕迹（诊断用）：$DSH_HOME/mobile-bridge-applied.log
//   module imported (impl)  —— 包模块被导入（进程启动 / entry 壳 ?t= 重导入）
//   module reloaded (impl)  —— 编辑器侦察位：本文件真被重新导入时打印；
//     若只改了文件却无此行，说明 loader 不重导入模块（fiber 跑的是启动那次 import），
//     必须重启宿主进程才能让改动生效（2026-10-01 实锤）。
const trace = (line) => {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    appendFileSync(path.join(home, 'mobile-bridge-applied.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
};
trace('module reloaded (impl)');
trace('module imported (impl)');
// ---- 工作区快速路径工具（跨平台：Windows 多盘符 / mac·Linux 单根）----

/** 列出存在的磁盘根（Windows: A:\–Z:\ 中实际存在的；mac/Linux: ['/']）。 */
function driveRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let i = 65; i <= 90; i++) {
      const d = `${String.fromCharCode(i)}:\\`;
      try {
        if (existsSync(d)) roots.push(d);
      } catch {}
    }
    return roots;
  }
  return ['/'];
}

/** 工作区快速路径：配置的常用路径（置顶）+ 系统根（多盘符并列 / 单根）。 */
function workspaceRoots(workspacePaths) {
  const quick = String(workspacePaths || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ path: p, label: path.basename(p) || p, quick: true }));
  const roots = driveRoots().map((r) => ({
    path: r,
    // 单根（mac/Linux 的 /）不展示盘符层，label 用系统名；多盘符展示 C:\ 等
    label: process.platform === 'win32' ? r : '/',
    quick: false,
  }));
  return { quick, roots, platform: process.platform, home: homedir() };
}

/** 列子目录（只目录、默认隐藏点开头）。返回 { ok, dirs, parent, path } 或 { ok:false, error }。
 *  只列目录不列文件：手机端仅用于「新建会话选工作区」，不给全盘文件名枚举能力。 */
function listSubdirs(dir, showHidden) {
  const target = String(dir || '').trim();
  if (!target) return { ok: false, error: '缺少 path 参数' };
  try {
    const real = path.resolve(target);
    if (!existsSync(real) || !statSync(real).isDirectory()) {
      return { ok: false, error: '目录不存在或不是目录' };
    }
    const entries = readdirSync(real, { withFileTypes: true });
    const vis = (name) => showHidden || !name.startsWith('.');
    const dirs = entries
      .filter((e) => e.isDirectory() && vis(e.name))
      .map((e) => ({ path: path.join(real, e.name), label: e.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const parent = path.dirname(real) === real ? null : path.dirname(real);
    return { ok: true, path: real, parent, dirs };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---- 共享文件区（.dsh-share）：手机与桌面/agent 的双向文件交换区 ----
// 模型（受控双向）：
//  - 读边界不变：手机只能读共享区（dl-create 强制池内），拿不到池外任何字节；
//  - 写边界新增（唯一上行）：手机经 share-upload-* 分块上传**只能落进共享区**，
//    桌面侧（人或 DSH 会话/agent）直接把文件写进目录即可下发；
//  - agent 侧零成本：上传落盘就是 <workspaceRoot>/.dsh-share 普通目录，会话直接读写。
// 区 = 工作区区 <workspaceRoot>/.dsh-share + 全局区 $DSH_HOME/.dsh-share。

const SHARE_DIRNAME = '.dsh-share';
const PART_SUFFIX = '.dshpart'; // 上传半成品，不列不传不可删（手机侧）

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh');
}

/** 全局区目录：$DSH_HOME/.dsh-share（默认 ~/.dsh/.dsh-share）。 */
function globalPoolDir() {
  return path.join(dshHomeDir(), SHARE_DIRNAME);
}

/** 工作区区目录：<workspaceRoot>/.dsh-share。 */
function workspacePoolDir(workspaceRoot) {
  return path.join(path.resolve(String(workspaceRoot || '')), SHARE_DIRNAME);
}

/** 路径相等比较（Windows 大小写不敏感）。 */
function samePath(a, b) {
  const x = path.resolve(String(a));
  const y = path.resolve(String(b));
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** 允许的区目录列表：全局区恒在；workspaceRoot 非空时加对应工作区区。 */
function allowedPoolDirs(workspaceRoot) {
  const dirs = [globalPoolDir()];
  const w = String(workspaceRoot || '').trim();
  if (w) {
    const d = workspacePoolDir(w);
    if (!dirs.some((x) => samePath(x, d))) dirs.push(d);
  }
  return dirs;
}

/** 文件是否在区目录第一层（resolve 消 symlink：区内 symlink 指向区外会被拒）。 */
function isPoolFile(filePath, workspaceRoot) {
  try {
    const real = path.resolve(String(filePath || ''));
    if (!existsSync(real) || !statSync(real).isFile()) return false;
    if (real.endsWith(PART_SUFFIX)) return false; // 半成品不可下载
    const parent = path.dirname(real);
    return allowedPoolDirs(workspaceRoot).some((d) => samePath(parent, d));
  } catch {
    return false;
  }
}

/** 列单个区目录：{ dir, available, files:[{name,path,size,mtime}] }，只列第一层普通文件（不含 .part）。 */
function listPoolDir(dir) {
  const available = existsSync(dir);
  const files = [];
  if (available) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || e.name.endsWith(PART_SUFFIX)) continue;
      const p = path.join(dir, e.name);
      let size = 0;
      let mtime = 0;
      try {
        const st = statSync(p);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {}
      files.push({ name: e.name, path: p, size, mtime });
    }
    files.sort((a, b) => b.mtime - a.mtime);
  }
  return { dir, available, files };
}

// ---- 手机上传（唯一上行通道）：分块 base64 → .part 暂存 → 完成改名落盘 ----
// 协议：init（配额/改名/断点）→ chunk×N（offset 严格递增追加）→ 完成；
// abort 丢弃半成品。读路径只有共享区，写不越区、量有上限（防塞盘）。

const SHARE_MAX_FILE = 512 * 1024 * 1024; // 单文件 512MB
const SHARE_MAX_TOTAL = 2 * 1024 * 1024 * 1024; // 全区总量 2GB（按现有文件累计）
const SHARE_CHUNK_MAX = 1024 * 1024; // 单块解码后 ≤1MB（手机端用 256KB）
const UPLOAD_TTL = 60 * 60 * 1000; // 上传会话 1h 过期
const UPLOAD_MAX_CONCURRENT = 20; // 并发上传会话上限（防 .part 喷涂）

// uploadId -> { partPath, finalPath, name, dir, size, offset, deviceId, startedAt }
const uploads = new Map();

/** 上传文件名清洗：basename 化、去控制字符、限长；非法返回 null。 */
function sanitizeUploadName(name) {
  let n = path.basename(String(name || '')).trim();
  n = n.replace(/[\x00-\x1f<>:"|?*]/g, '');
  if (n === '.' || n === '..') return null;
  if (n.toLowerCase().endsWith(PART_SUFFIX)) return null;
  if (!n || n.length > 200 || /[\\/]/.test(n)) return null;
  return n;
}

/** 区目录现有占用（字节，不含 .part——part 属于在途上传，init 时单独累计）。 */
function shareUsage(dir) {
  const listed = listPoolDir(dir);
  return listed.files.reduce((s, f) => s + f.size, 0);
}

/** 同名冲突自动加 (1)/(2)… 后缀（对已存在文件与在途 .part 都避让）。 */
function shareTargetName(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : `${base} (${i})${ext}`;
    if (!existsSync(path.join(dir, candidate)) && !existsSync(path.join(dir, candidate + PART_SUFFIX))) return candidate;
  }
  return `${base}-${Date.now()}${ext}`;
}

/** 清理过期上传会话（1h 无进展）：删 .part + 移除 tracker。 */
function pruneUploads() {
  const cutoff = Date.now() - UPLOAD_TTL;
  for (const [id, u] of uploads) {
    if (u.startedAt < cutoff) {
      try { unlinkSync(u.partPath); } catch {}
      uploads.delete(id);
    }
  }
}

// ---- 附件下载：随机唯一链接（绑定设备、默认 30min、上限 7 天）----

const DL_DEFAULT_TTL = 1800; // 30min
const DL_MAX_TTL = 7 * 24 * 3600; // 7 天上限（不允许永久）
// 下载记录：downloadId -> { path, name, size, deviceId, expiresAt, createdAt }
const downloads = new Map();

/** 生成下载链接：绑 deviceId，有效期限 [1, DL_MAX_TTL]，默认 30min。
 *  [workspaceRoot]：当前会话 cwd——决定放行哪个工作区池（+全局池）。
 *  池外路径一律拒绝（下载池模型的安全边界）。 */
function dlCreate(filePath, deviceId, expiresInSec, workspaceRoot) {
  const real = path.resolve(String(filePath || ''));
  if (!real || !existsSync(real) || !statSync(real).isFile()) {
    return { ok: false, error: '文件不存在' };
  }
  if (!deviceId) return { ok: false, error: '缺少设备标识' };
  if (!isPoolFile(real, workspaceRoot)) {
    return { ok: false, error: '仅允许下载共享文件区（.dsh-share）内文件：请在电脑上把文件放入 .dsh-share 目录' };
  }
  let ttl = Number(expiresInSec);
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = DL_DEFAULT_TTL;
  ttl = Math.min(Math.floor(ttl), DL_MAX_TTL);
  const id = randomBytes(16).toString('base64url');
  const now = Date.now();
  downloads.set(id, {
    path: real,
    name: path.basename(real),
    size: statSync(real).size,
    deviceId: String(deviceId),
    expiresAt: now + ttl * 1000,
    createdAt: now,
  });
  return { ok: true, downloadId: id, expiresAt: now + ttl * 1000, ttl };
}

/** 校验下载：存在、未过期、设备匹配。返回记录或错误。 */
function dlVerify(id, deviceId) {
  const rec = downloads.get(String(id || ''));
  if (!rec) return { ok: false, status: 404, error: '链接不存在' };
  if (Date.now() > rec.expiresAt) {
    downloads.delete(id);
    return { ok: false, status: 410, error: '链接已过期' };
  }
  if (rec.deviceId !== String(deviceId || '')) {
    return { ok: false, status: 403, error: '设备不匹配' };
  }
  if (!existsSync(rec.path)) {
    downloads.delete(id);
    return { ok: false, status: 410, error: '文件已不存在' };
  }
  return { ok: true, rec };
}

/** 列出有效下载链接（管理页用），自动清理过期项。 */
function dlList() {
  const now = Date.now();
  for (const [id, r] of downloads) {
    if (now > r.expiresAt) downloads.delete(id);
  }
  return [...downloads.entries()]
    .map(([id, r]) => ({
      downloadId: id,
      name: r.name,
      path: r.path,
      size: r.size,
      deviceId: r.deviceId,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** 撤销下载链接。 */
function dlRevoke(id) {
  return downloads.delete(String(id || ''));
}

// ---- HTTP 小工具（工作区/下载路由共用）----

function isLoopback(req) {
  const remote = req.socket?.remoteAddress ?? '';
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

/** 请求方设备标识：优先 x-device-id 头（同 relay 设备令牌机制），回退 query d。 */
function deviceIdOf(req) {
  return req.headers?.['x-device-id'] || req.headers?.['X-Device-Id'] || '';
}

function jsonOk(res, result) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code: 200, result }));
}

function jsonErr(res, code, message) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ code, message: String(message || '') }));
}

export function apply(ctx, config) {
  // loader 热替换可能传 null（默认参数只兜 undefined 不兜 null）——非对象一律视为空配置
  const cfg = (config && typeof config === 'object') ? config : {};
  trace(`apply called (config keys: ${Object.keys(cfg).join(',') || 'none'})`);
  try {
    const mk = (level, fallback) => (m) => {
      trace(`${level}: ${m}`); // 诊断：桥日志同步进 trace 文件（桌面 stdout 不可见）
      const l = ctx.logger?.('mobile-bridge');
      if (l && typeof l[level] === 'function') l[level](m);
      else fallback(`[mobile-bridge] ${m}`);
    };
    const logger = {
      info: mk('info', (m) => console.log(m)),
      error: mk('error', (m) => console.error(m)),
    };

    // volatile 字段在运行实例是引用（.get()）；冷启动直载/测试桩可能是裸值
    const read = (v) => (v && typeof v === 'object' && typeof v.get === 'function' ? v.get() : v);
    const current = () => ({
      relayUrl: read(cfg.relayUrl),
      code: read(cfg.code),
      dshUrl: read(cfg.dshUrl),
      pairingCode: read(cfg.pairingCode),
      workspacePaths: read(cfg.workspacePaths),
    });

    const bridge = new MobileBridge(resolveConfig(current()), logger);
    const activate = () => {
      const merged = resolveConfig(current());
      const was = bridge.started;
      // 无条件 close+start：bridge.update() 只重启「曾启动」的桥——缺码被 start() 拒绝后，
      // 补码走 update() 永远起不来（2026-09-30 实锤）。close() 对未启动的桥无害。
      bridge.close();
      bridge.config = merged;
      bridge.start();
      trace(`activate (was=${was} now=${bridge.started})`);
    };
    activate();
    // 行配置保存（volatile 写回）→ 桥按新配置热重启
    ctx.on('loader/volatile-update', () => {
      try {
        activate();
      } catch (e) {
        trace(`volatile-update FAILED: ${(e && e.stack) || e}`);
      }
    });

    // launch token（本进程会话令牌）：经 ctx.connection.authenticatedUrl 提取，
    // 供行配置页自动预填安全码与手机端入网（环回限定，不对外暴露）。
    // 单独 inject：connection 缺席时路由照常注册，token 路由回 500 而非卡死 fiber。
    let connection = null;
    ctx.inject(['connection'], (cCtx) => {
      connection = cCtx.connection;
    });
    const launchToken = () => {
      try {
        const u = new URL(connection?.authenticatedUrl?.('http://localhost/') ?? '');
        return u.searchParams.get('token') || '';
      } catch {
        return '';
      }
    };

    // 状态/邀请路由（前缀 /mobile-bridge）：行配置页轮询桥状态、代领配对码/局域网直连出二维码。
    // webServer 的 handler 是 node 风格 (req, res)；req.url 为路径+查询。
    const serveStatus = async (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://x').pathname;
      if (req.method === 'GET' && pathname === '/mobile-bridge/status') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(bridge.status()));
        return;
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/invite') {
        try {
          let body = '';
          for await (const chunk of req) body += chunk;
          const { name = '' } = JSON.parse(body || '{}');
          const out = await bridge.inviteCode(String(name));
          // 扫码 payload + QR（手机扫后自动建转发环境并配对）
          const { default: QRCode } = await import('qrcode');
          const addr = new URL(bridge.config.relayUrl).host;
          const payload = `dshrelay://${addr}/?pair=${out.code}&room=${out.room || ''}&name=${encodeURIComponent(name || '')}`;
          const qr = await QRCode.toDataURL(payload, { width: 220, margin: 1 });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 200, result: { ...out, payload, qr } }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 500, message: String(e?.message || e) }));
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/lan-qr') {
        // 局域网直连出码：dshlan://<lanIp>:<dshPort>/?code=<安全码>&name=<电脑名>
        // 安全码=launch token（浏览器地址栏 ?token= 可手填），手机扫码即建局域网环境。
        try {
          const u = new URL(req.url ?? '/', 'http://x');
          const code = u.searchParams.get('code') || '';
          const name = u.searchParams.get('name') || '';
          const { default: QRCode } = await import('qrcode');
          const port = new URL(bridge.config.dshUrl).port || '3080';
          const host = lanAddress();
          const payload = `dshlan://${host}:${port}/?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`;
          const qr = await QRCode.toDataURL(payload, { width: 220, margin: 1 });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 200, result: { payload, qr, host, port } }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 500, message: String(e?.message || e) }));
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/workspace-roots') {
        // 工作区快速路径（环回限定）：多盘符并列 / 单根 + 配置的常用工作区（置顶）。
        try {
          const remote = req.socket?.remoteAddress ?? '';
          const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
          if (!loopback) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ code: 403, message: '仅本机可访问' }));
            return;
          }
          const result = workspaceRoots(current().workspacePaths);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 200, result }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 500, message: String(e?.message || e) }));
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/workspace-list') {
        // 列子目录（环回限定）：只列目录、默认隐藏点开头，供手机端逐层下钻。
        try {
          const remote = req.socket?.remoteAddress ?? '';
          const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
          if (!loopback) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ code: 403, message: '仅本机可访问' }));
            return;
          }
          const u = new URL(req.url ?? '/', 'http://x');
          const dir = u.searchParams.get('path') || '';
          const showHidden = u.searchParams.get('hidden') === '1';
          // files=1 已废弃：只读池模型下手机不需要也不应枚举全盘文件名（参数静默忽略）
          const result = listSubdirs(dir, showHidden);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result.ok ? { code: 200, result } : { code: 400, message: result.error }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 500, message: String(e?.message || e) }));
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/dl-create') {
        // 生成下载链接（环回限定）：body {path, expiresInSec?, deviceId?, workspaceRoot?}。
        // 仅放行共享区（.dsh-share）内文件（工作区区 workspaceRoot/.dsh-share + 全局区）。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const deviceId = String(body.deviceId || deviceIdOf(req) || '');
          const out = dlCreate(body.path, deviceId, body.expiresInSec, body.workspaceRoot);
          return out.ok
            ? jsonOk(res, { downloadId: out.downloadId, expiresAt: out.expiresAt, ttl: out.ttl })
            : jsonErr(res, 403, out.error);
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'GET' && pathname.startsWith('/mobile-bridge/dl/')) {
        // 下载文件（环回限定 + 设备绑定）：/mobile-bridge/dl/<id>?d=<deviceId>
        // 流式（createReadStream.pipe）+ Range 断点（206/Content-Range），大文件不进内存。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const u = new URL(req.url ?? '/', 'http://x');
          const id = pathname.slice('/mobile-bridge/dl/'.length);
          const deviceId = u.searchParams.get('d') || deviceIdOf(req) || '';
          const v = dlVerify(id, deviceId);
          if (!v.ok) return jsonErr(res, v.status, v.error);
          const rec = v.rec;
          const baseHeaders = {
            'content-type': 'application/octet-stream',
            'accept-ranges': 'bytes',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rec.name)}`,
          };
          // Range 断点：bytes=start-end / bytes=start-
          const range = req.headers?.range || req.headers?.Range;
          const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range));
          if (m && (m[1] || m[2])) {
            const start = m[1] ? parseInt(m[1], 10) : 0;
            const end = m[2] ? Math.min(parseInt(m[2], 10), rec.size - 1) : rec.size - 1;
            if (start > end || start >= rec.size) {
              // 416 带 octet-stream + 0 长度：隧道的流式分支得以接管
              // （meta{status:416} + last 双帧收尾），手机端判定「本地已完整」而非挂死
              res.writeHead(416, { ...baseHeaders, 'content-range': `bytes */${rec.size}`, 'content-length': '0' });
              res.end();
              return;
            }
            res.writeHead(206, {
              ...baseHeaders,
              'content-range': `bytes ${start}-${end}/${rec.size}`,
              'content-length': end - start + 1,
            });
            createReadStream(rec.path, { start, end }).pipe(res);
            return;
          }
          res.writeHead(200, { ...baseHeaders, 'content-length': rec.size });
          createReadStream(rec.path).pipe(res);
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
        return;
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/dl-list') {
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          return jsonOk(res, { items: dlList() });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/dl-pool') {
        // 共享区列表（环回限定）：工作区区（?workspace=<会话cwd>）+ 全局区，各列第一层文件（不含 .part）。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const u = new URL(req.url ?? '/', 'http://x');
          const w = (u.searchParams.get('workspace') || '').trim();
          const g = listPoolDir(globalPoolDir());
          const ws = w ? listPoolDir(workspacePoolDir(w)) : null;
          const items = [
            ...(ws ? ws.files.map((f) => ({ ...f, pool: 'workspace' })) : []),
            ...g.files.map((f) => ({ ...f, pool: 'global' })),
          ];
          return jsonOk(res, {
            items,
            workspace: ws ? { root: path.resolve(w), dir: ws.dir, available: ws.available } : null,
            global: { dir: g.dir, available: g.available },
          });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/dl-pool-delete') {
        // 删除池内文件（环回限定）：只允许删池目录第一层的普通文件。
        // body {name, pool:'workspace'|'global', workspaceRoot?, deviceId?}。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const deviceId = String(body.deviceId || deviceIdOf(req) || '');
          if (!deviceId) return jsonErr(res, 400, '缺少设备标识');
          const name = String(body.name || '');
          if (!name || path.basename(name) !== name || name === '.' || name === '..' || /[\\/]/.test(name)) {
            return jsonErr(res, 400, '非法文件名');
          }
          if (name.endsWith(PART_SUFFIX)) return jsonErr(res, 400, '上传中的半成品不可删除');
          const fromWorkspace = body.pool === 'workspace';
          if (fromWorkspace && !String(body.workspaceRoot || '').trim()) {
            return jsonErr(res, 400, '缺少工作区路径（workspaceRoot）');
          }
          const dir = fromWorkspace ? workspacePoolDir(body.workspaceRoot) : globalPoolDir();
          const target = path.join(dir, name);
          if (!isPoolFile(target, body.workspaceRoot)) {
            return jsonErr(res, 404, '文件不在共享区（.dsh-share）内');
          }
          unlinkSync(target);
          return jsonOk(res, { deleted: true, name });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      // ---- 手机上传（共享文件区唯一上行通道）----
      if (req.method === 'POST' && pathname === '/mobile-bridge/share-upload-init') {
        // 开启/续传上传会话（环回限定）。
        // body {name, size, deviceId?, workspaceRoot?, target:'workspace'|'global'}
        // → { uploadId, name, path, offset(断点续传起点), chunkMax }；size=0 直接落盘 done。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const deviceId = String(body.deviceId || deviceIdOf(req) || '');
          if (!deviceId) return jsonErr(res, 400, '缺少设备标识');
          const name = sanitizeUploadName(body.name);
          if (!name) return jsonErr(res, 400, '非法文件名');
          const size = Number(body.size);
          if (!Number.isFinite(size) || size < 0 || size > SHARE_MAX_FILE) {
            return jsonErr(res, 400, `文件大小非法或超上限（≤${Math.floor(SHARE_MAX_FILE / 1024 / 1024)}MB）`);
          }
          const toWorkspace = body.target === 'workspace';
          if (toWorkspace && !String(body.workspaceRoot || '').trim()) {
            return jsonErr(res, 400, '缺少工作区路径（workspaceRoot）');
          }
          const dir = toWorkspace ? workspacePoolDir(body.workspaceRoot) : globalPoolDir();
          mkdirSync(dir, { recursive: true });
          pruneUploads();
          if (uploads.size >= UPLOAD_MAX_CONCURRENT) return jsonErr(res, 429, '上传会话过多，稍后再试');
          // 配额：现有占用 + 同区在途 .part + 本次 ≤ 2GB（防配对手机塞盘）
          let pending = 0;
          for (const [, up] of uploads) {
            if (samePath(up.dir, dir)) pending += up.size;
          }
          if (shareUsage(dir) + pending + size > SHARE_MAX_TOTAL) {
            return jsonErr(res, 400, '共享区总容量超上限（2GB），请先清理');
          }
          // 断点续传：同名 .part 且未超声明大小 → 沿用同名接着传（offset=已收字节）
          let final = null;
          let offset = 0;
          const directPart = path.join(dir, name + PART_SUFFIX);
          if (size > 0 && existsSync(directPart)) {
            const ps = statSync(directPart).size;
            if (ps <= size) {
              final = name;
              offset = ps;
            } else {
              try { unlinkSync(directPart); } catch {} // 脏 part（超声明大小）：丢弃重来
            }
          }
          if (final === null) final = shareTargetName(dir, name);
          const finalPath = path.join(dir, final);
          if (size === 0) {
            writeFileSync(finalPath, ''); // 空文件直接完成
            return jsonOk(res, { uploadId: '', done: true, name: final, path: finalPath, offset: 0, chunkMax: SHARE_CHUNK_MAX });
          }
          const id = randomBytes(12).toString('base64url');
          uploads.set(id, { partPath: finalPath + PART_SUFFIX, finalPath, name: final, dir, size, offset, deviceId, startedAt: Date.now() });
          return jsonOk(res, { uploadId: id, name: final, path: finalPath, offset, chunkMax: SHARE_CHUNK_MAX });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/share-upload-chunk') {
        // 追加一块（环回限定）：?id=<uploadId>&offset=<n>，body=base64 块（解码后 ≤1MB）。
        // offset 必须等于服务端当前值（严格顺序写，防乱序/重放）；收满即改名落盘。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const u = new URL(req.url ?? '/', 'http://x');
          const id = u.searchParams.get('id') || '';
          const up = uploads.get(id);
          if (!up) return jsonErr(res, 404, '上传会话不存在或已过期');
          const off = Number(u.searchParams.get('offset'));
          if (!Number.isFinite(off) || off !== up.offset) {
            return jsonErr(res, 409, `offset 不匹配（服务端当前 ${up.offset}，收到 ${off}）`);
          }
          const raw = String(await readBody(req) || '');
          if (!raw || !/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) return jsonErr(res, 400, '空块或非 base64 内容');
          const buf = Buffer.from(raw, 'base64');
          if (buf.length === 0) return jsonErr(res, 400, '空块');
          if (buf.length > SHARE_CHUNK_MAX) return jsonErr(res, 400, '块过大');
          if (up.offset + buf.length > up.size) return jsonErr(res, 400, '超出声明大小');
          appendFileSync(up.partPath, buf);
          up.offset += buf.length;
          up.startedAt = Date.now(); // 有进展即续期（1h 滑动窗口）
          if (up.offset >= up.size) {
            renameSync(up.partPath, up.finalPath); // 半成品转正：原子改名，此后 dl-pool 可见
            uploads.delete(id);
            return jsonOk(res, { done: true, offset: up.offset, name: up.name, path: up.finalPath, size: up.size });
          }
          return jsonOk(res, { done: false, offset: up.offset });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/share-upload-abort') {
        // 放弃上传（环回限定）：删 .part 半成品 + 会话。body {uploadId, deviceId?}。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const id = String(body.uploadId || '');
          const up = uploads.get(id);
          if (!up) return jsonErr(res, 404, '上传会话不存在');
          try { unlinkSync(up.partPath); } catch {}
          uploads.delete(id);
          return jsonOk(res, { aborted: true });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/host-status') {
        // 宿主状态看板（环回限定；手机经 relay 通用转发到达）：
        // 进程/窗口清单 + capabilities（平台能力协商，端上按能力隐藏 UI）。
        // hostmon 以 30s 桶 ?t= 动态导入：编辑后 ≤30s 生效，免重启宿主；
        // 桶控避免 loader 模块图按 URL 无限记忆。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const t = Math.floor(Date.now() / 30000);
          const m = await import(`./hostmon.js?t=${t}`);
          return jsonOk(res, await m.hostStatus());
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/window-capture') {
        // 按窗口截图（环回限定 + 设备绑定）：body {id, deviceId?}。
        // PNG 落全局共享区 → dlCreate 600s 链接（复用池模型：设备绑定/分块/过期清理）。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const deviceId = String(body.deviceId || deviceIdOf(req) || '');
          if (!deviceId) return jsonErr(res, 400, '缺少设备标识');
          const m = await import(`./hostmon.js?t=${Math.floor(Date.now() / 30000)}`);
          const out = await m.captureWindow(String(body.id || ''), globalPoolDir());
          if (!out.ok) return jsonErr(res, 400, out.error);
          const dl = dlCreate(out.file, deviceId, 600, '');
          if (!dl.ok) return jsonErr(res, 500, dl.error);
          return jsonOk(res, {
            downloadId: dl.downloadId,
            expiresAt: dl.expiresAt,
            name: out.name,
            size: out.size,
          });
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/dl-revoke') {
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const ok = dlRevoke(body.downloadId);
          return ok ? jsonOk(res, { revoked: true }) : jsonErr(res, 404, '链接不存在');
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'GET' && pathname === '/mobile-bridge/launch-token') {
        // 环回限定：launch token 只给本机请求（页面自动预填/本机自动化），不泄给网络侧
        const remote = req.socket?.remoteAddress ?? '';
        const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
        const token = loopback ? launchToken() : '';
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(token ? { code: 200, result: { token } } : { code: 500, message: 'launch token 不可用' }));
        return;
      }
      res.writeHead(404);
      res.end();
    };
    ctx.inject(['webServer'], (webCtx) => {
      try {
        webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/mobile-bridge', handler: serveStatus }), 'mobile-bridge: status route');
      } catch (e) {
        // 注册失败必须留证（launch-token 404 类问题的取证缺口），原样抛出让 fiber 标失败
        trace(`webServer.register FAILED: ${(e && e.stack) || e}`);
        throw e;
      }
    });

    ctx.effect(() => () => bridge.close());
  } catch (e) {
    // 绝不静默半死：trace 留证后原样抛出，让 loader 把 fiber 标记为失败
    trace(`apply FAILED: ${(e && e.stack) || e}`);
    throw e;
  }
}

// default 兼容直载入口（dsh-relay-plugin/plugin 子路径等）——对象形态而非裸函数：
// loader 取 exports.default ?? exports 后只读 plugin.Config，裸函数会遮蔽 schema。
export default { apply, Config };
