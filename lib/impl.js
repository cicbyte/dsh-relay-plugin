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

import { appendFileSync, readdirSync, statSync, existsSync, readdir, createReadStream } from 'node:fs';
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

/** 列子目录（只目录、默认隐藏点开头）。返回 { ok, dirs, parent, path } 或 { ok:false, error }。 */
function listSubdirs(dir, showHidden, withFiles = false) {
  const target = String(dir || '').trim();
  if (!target) return { ok: false, error: '缺少 path 参数' };
  let real;
  try {
    real = path.resolve(target);
    if (!existsSync(real) || !statSync(real).isDirectory()) {
      return { ok: false, error: '目录不存在或不是目录' };
    }
    const entries = readdirSync(real, { withFileTypes: true });
    const vis = (name) => showHidden || !name.startsWith('.');
    const dirs = entries
      .filter((e) => e.isDirectory() && vis(e.name))
      .map((e) => ({ path: path.join(real, e.name), label: e.name }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const files = withFiles
      ? entries
          .filter((e) => e.isFile() && vis(e.name))
          .map((e) => {
            const p = path.join(real, e.name);
            let size = 0;
            try { size = statSync(p).size; } catch {}
            return { path: p, label: e.name, size };
          })
          .sort((a, b) => a.label.localeCompare(b.label))
      : [];
    const parent = path.dirname(real) === real ? null : path.dirname(real);
    return { ok: true, path: real, parent, dirs, files };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// ---- 附件下载：随机唯一链接（绑定设备、默认 30min、上限 7 天）----

const DL_DEFAULT_TTL = 1800; // 30min
const DL_MAX_TTL = 7 * 24 * 3600; // 7 天上限（不允许永久）
// 下载记录：downloadId -> { path, name, size, deviceId, expiresAt, createdAt }
const downloads = new Map();

/** 生成下载链接：绑 deviceId，有效期限 [1, DL_MAX_TTL]，默认 30min。 */
function dlCreate(filePath, deviceId, expiresInSec) {
  const real = path.resolve(String(filePath || ''));
  if (!real || !existsSync(real) || !statSync(real).isFile()) {
    return { ok: false, error: '文件不存在' };
  }
  if (!deviceId) return { ok: false, error: '缺少设备标识' };
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
          const withFiles = u.searchParams.get('files') === '1';
          const result = listSubdirs(dir, showHidden, withFiles);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result.ok ? { code: 200, result } : { code: 400, message: result.error }));
        } catch (e) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ code: 500, message: String(e?.message || e) }));
        }
        return;
      }
      if (req.method === 'POST' && pathname === '/mobile-bridge/dl-create') {
        // 生成下载链接（环回限定）：body {path, expiresInSec?, deviceId?}，绑定设备。
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const body = JSON.parse(await readBody(req) || '{}');
          const deviceId = String(body.deviceId || deviceIdOf(req) || '');
          const out = dlCreate(body.path, deviceId, body.expiresInSec);
          return out.ok
            ? jsonOk(res, { downloadId: out.downloadId, expiresAt: out.expiresAt, ttl: out.ttl })
            : jsonErr(res, 400, out.error);
        } catch (e) {
          return jsonErr(res, 500, String(e?.message || e));
        }
      }
      if (req.method === 'GET' && pathname.startsWith('/mobile-bridge/dl/')) {
        // 下载文件（环回限定 + 设备绑定）：/mobile-bridge/dl/<id>?d=<deviceId>
        try {
          if (!isLoopback(req)) return jsonErr(res, 403, '仅本机可访问');
          const u = new URL(req.url ?? '/', 'http://x');
          const id = pathname.slice('/mobile-bridge/dl/'.length);
          const deviceId = u.searchParams.get('d') || deviceIdOf(req) || '';
          const v = dlVerify(id, deviceId);
          if (!v.ok) return jsonErr(res, v.status, v.error);
          const rec = v.rec;
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': rec.size,
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(rec.name)}`,
          });
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
