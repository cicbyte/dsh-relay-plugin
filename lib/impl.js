// dsh-relay-plugin 宿主半实现：桌面桥 + 设置命名空间（界面配置的数据源）。
//
// 插件形状（与 dsh-theme-amber 同约定）：导出 apply(ctx, config)。
// 生命周期：随 fiber 起停——apply 内启动桥，ctx.effect 注册的 disposer 在
// entry 被 disable/移除/进程退出时关闭全部连接。
//
// 配置来源（优先级从高到低）：
//   1. 设置文档 mobile-bridge 命名空间（UI「手机通道」页面的用户层，实时热生效）；
//   2. loader entry config 字段 / 环境变量 RELAY_URL/RELAY_CODE/DSH_URL /
//      $DSH_HOME/mobile-bridge.json —— 同时构成设置命名空间的 base 组合层
//      （用户层字段被清除后回落到这里）。
//
// 注意：入口见 index.js（转出本文件）与 exports 的 ./plugin 子路径——
// loader 的 import 缓存按 URL 命中，运行实例里改文件需换子路径绕缓存或重启。

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

// bridge 带 query 破缓存地动态导入：loader 的模块图按 URL 记忆/毒化，
// 热激活路径每次 apply 都拿全新桥模块（冷启动无害，多一份实例而已）。
const { MobileBridge, resolveConfig, lanAddress } = await import(`./bridge.js?t=${Date.now()}`);

const NS = 'mobile-bridge';

/** 设置命名空间 schema：桥的配置（wire 信封即浏览器侧校验 schema）。 */
const MobileBridgeSettingsSchema = z.object({
  relayUrl: z.string().default('ws://127.0.0.1:8787'),
  code: z.string().default(''),
  dshUrl: z.string().default('http://127.0.0.1:3080'),
  pairingCode: z.string().default(''),
});

// 落地痕迹（诊断用）：$DSH_HOME/mobile-bridge-applied.log
const trace = (line) => {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    appendFileSync(path.join(home, 'mobile-bridge-applied.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
};
trace('module imported (impl)');

export function apply(ctx, config = {}) {
  trace(`apply called (config keys: ${Object.keys(config ?? {}).join(',') || 'none'})`);
  const mk = (level, fallback) => (m) => {
    const l = ctx.logger?.('mobile-bridge');
    if (l && typeof l[level] === 'function') l[level](m);
    else fallback(`[mobile-bridge] ${m}`);
  };
  const logger = {
    info: mk('info', (m) => console.log(m)),
    error: mk('error', (m) => console.error(m)),
  };

  const base = resolveConfig(config ?? {}); // env / 文件兜底 = 设置的 base 组合层
  const bridge = new MobileBridge(base, logger);
  let started = false;
  const activate = (section) => {
    const merged = { ...base, ...(section ?? {}) };
    trace(`activate (source: ${section ? 'settings' : 'fallback'})`);
    if (started) bridge.close(); // 换配置热重启：拆旧连接再按新配置起
    bridge.config = merged;
    bridge.start();
    started = true;
  };

  // 设置服务就绪：注册命名空间（base=文件/环境配置），读取当前解析值起桥，
  // 并监听 settings/updated 实时热重载（UI 保存 → 桥立即换配置重连）。
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NS, MobileBridgeSettingsSchema, { base });
    activate(settingsCtx.settings.get(NS));
    ctx.on('settings/updated', (ns, next) => {
      if (String(ns) === NS) activate(next);
    });
  });
  // 设置服务缺席时直接用兜底配置起桥（inject 回调晚到时 activate 会覆盖）。
  if (ctx.get('settings') === undefined) activate(null);

  // 状态/邀请路由（前缀 /mobile-bridge）：设置页轮询桥状态、代领配对码出二维码。
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
    res.writeHead(404);
    res.end();
  };
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({ kind: 'prefix', path: '/mobile-bridge', handler: serveStatus }), 'mobile-bridge: status route');
  });

  ctx.effect(() => () => bridge.close());
}

export default apply;
