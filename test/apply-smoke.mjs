// 插件形状冒烟：apply + 行配置 schema + /mobile-bridge 路由注册 + volatile 热重启 + disposer 生命周期。
// 含 2026-09-30 实锤的崩溃形态回归：loader 热替换会传 null config（默认参数只兜 undefined）。
// 用法：node test/apply-smoke.mjs
import { apply, Config } from '../lib/index.js';

function mkCtx() {
  const calls = { effect: 0, routes: [], volatileHandlers: [] };
  const disposers = [];
  const fakeWebServer = {
    register(row) {
      calls.routes.push(row);
      return () => {};
    },
  };
  const ctx = {
    logger: () => ({ info() {}, error() {} }),
    get(name) { return name === 'webServer' ? { webServer: fakeWebServer } : undefined; },
    inject(deps, cb) { cb({ webServer: fakeWebServer, effect: (fn) => { calls.effect += 1; disposers.push(fn()); return disposers.at(-1); } }); },
    on(event, handler) { if (event === 'loader/volatile-update') calls.volatileHandlers.push(handler); },
    effect(fn) { calls.effect += 1; disposers.push(fn()); return disposers.at(-1); },
  };
  return { ctx, calls, disposers };
}

const assert = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); process.exit(1); }
  console.log('ok:', label);
};

assert(Config && (typeof Config === 'object' || typeof Config === 'function'), 'Config schema 导出（volatile 字段 = 行配置表单数据源）');

// ---- 正常形态：裸字符串值 = 冷启动直载/测试桩形态 ----
const a = mkCtx();
// apply 不应抛；桥会真连 relay（连不上也只是退避重连，进程退出即止）。
apply(a.ctx, { relayUrl: 'ws://127.0.0.1:8787', code: 'test-code-123456', dshUrl: 'http://127.0.0.1:3080', pairingCode: '' });
assert(a.calls.routes.length === 1 && a.calls.routes[0].path === '/mobile-bridge', '状态路由注册（/mobile-bridge 前缀）');
assert(a.calls.volatileHandlers.length === 1, 'loader/volatile-update 订阅（行配置保存 → 桥热重启）');
assert(a.disposers.length === 2, 'effect 两个 disposer（桥 + 状态路由）');
a.calls.volatileHandlers[0]();
assert(true, 'loader/volatile-update 热重启不抛');
for (const d of a.disposers) d();

// ---- 崩溃形态回归：null / undefined / {} 都必须无恙（loader 热替换传 null config） ----
for (const [arg, label] of [[null, 'null'], [undefined, 'undefined'], [{}, '{}']]) {
  const b = mkCtx();
  try {
    apply(b.ctx, arg);
  } catch (e) {
    console.error(`FAIL: apply(ctx, ${label}) 抛了：`, e.message);
    process.exit(1);
  }
  assert(b.calls.routes.length === 1, `apply(ctx, ${label}) 存活且路由照常注册`);
  for (const d of b.disposers) d();
}

console.log('[smoke] PASS：Config schema + 路由注册 + volatile 热重启 + null config 回归 + disposer 关闭');
process.exit(0);
