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

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
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
});

// 落地痕迹（诊断用）：$DSH_HOME/mobile-bridge-applied.log
const trace = (line) => {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    appendFileSync(path.join(home, 'mobile-bridge-applied.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
};
trace('module imported (impl)');

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
      webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/mobile-bridge', handler: serveStatus }), 'mobile-bridge: status route');
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
