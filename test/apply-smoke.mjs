// 插件形状冒烟：apply + settings 命名空间注册 + effect 生命周期 + settings/updated 热重载。
// 用法：node test/apply-smoke.mjs
import { apply } from '../lib/index.js';

const calls = { effect: 0, registered: [] };
let updateHandler = null;
let settingsGet = { relayUrl: 'ws://127.0.0.1:8787', code: 'smoke-code-123', dshUrl: 'http://127.0.0.1:3080' };

const fakeSettings = {
  register(ns, schema, options) {
    calls.registered.push({ ns, hasSchema: !!schema, base: options?.base });
    return {};
  },
  get(ns) {
    if (ns !== 'mobile-bridge') throw new Error('unexpected ns: ' + ns);
    return settingsGet;
  },
};

const fakeWebServer = {
  register(row) {
    calls.routes = calls.routes || [];
    calls.routes.push(row);
    return () => {};
  },
};

const disposers = [];
const ctx = {
  logger: () => ({ info() {}, error() {} }),
  get(name) { return name === 'settings' ? { settings: fakeSettings } : name === 'webServer' ? { webServer: fakeWebServer } : undefined; },
  inject(deps, cb) {
    const fakeCtx = { webServer: fakeWebServer, settings: fakeSettings, effect: (fn) => { disposers.push(fn()); return disposers.at(-1); } };
    cb(fakeCtx);
  },
  on(event, handler) { if (event === 'settings/updated') updateHandler = handler; },
  effect(fn) { calls.effect += 1; disposers.push(fn()); return disposers.at(-1); },
};

// apply 不应抛；桥会真连 relay（连不上也只是退避重连，进程退出即止）
apply(ctx, { code: 'test-code-123456' });

const assert = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); process.exit(1); }
  console.log('ok:', label);
};

assert(calls.registered.length === 1 && calls.registered[0].ns === 'mobile-bridge', 'settings.register(mobile-bridge)');
assert(typeof updateHandler === 'function', 'settings/updated 订阅');
assert(disposers.length === 2, 'effect 两个 disposer（桥 + 状态路由）');
assert((calls.routes || []).some((r) => r.path === '/mobile-bridge'), '状态路由注册');

// settings 更新 → 热重载（close+start 路径）；非本命名空间应忽略
settingsGet = { relayUrl: 'ws://127.0.0.1:8787', code: 'smoke-code-456', dshUrl: 'http://127.0.0.1:3080' };
updateHandler('mobile-bridge', settingsGet);
updateHandler('other-ns', {});
assert(true, 'settings/updated 热重载不抛');

for (const d of disposers) d();
console.log('[smoke] PASS：apply 形状 + settings 命名空间 + 热重载 + disposer 关闭');
process.exit(0);
