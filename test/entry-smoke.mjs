// entry.js 热激活壳冒烟：apply 必须真跑到 impl.apply（async 壳的 await 不到位就静默不执行）。
// 用法：node test/entry-smoke.mjs
import * as mod from '../lib/entry.js';

const calls = { applied: 0, routes: 0, volatile: 0, disposers: 0 };
const fakeWebServer = { register() { calls.routes += 1; return () => {}; } };
const ctx = {
  logger: () => ({ info() {}, error() {} }),
  get(name) { return name === 'webServer' ? { webServer: fakeWebServer } : undefined; },
  inject(deps, cb) { cb({ webServer: fakeWebServer, effect: (fn) => { calls.disposers += 1; return fn(); } }); },
  on(event) { if (event === 'loader/volatile-update') calls.volatile += 1; },
  effect(fn) { calls.disposers += 1; return fn(); },
};

const assert = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); process.exit(1); }
  console.log('ok:', label);
};

assert(typeof mod.apply === 'function', 'entry 壳导出 apply');
assert(mod.Config && (typeof mod.Config === 'object' || typeof mod.Config === 'function'), 'entry 壳内联导出 Config（loader 同步读）');

const ret = mod.apply(ctx, { relayUrl: 'ws://127.0.0.1:8787', code: 'entry-smoke-code', dshUrl: 'http://127.0.0.1:3080', pairingCode: '' });
assert(ret && typeof ret.then === 'function', 'apply 返回 Promise（壳是 async）');
const inner = await ret;
assert(inner === undefined || typeof inner === 'object' || typeof inner === 'function', 'impl.apply 返回值透传/不抛');
assert(calls.routes === 1, `经壳的 impl.apply 真执行（路由注册 = ${calls.routes}）`);
assert(calls.volatile === 1, 'volatile-update 订阅经壳到位');

console.log('[entry-smoke] PASS：entry 壳 → impl.apply 链路 + Config 内联导出 + 路由/订阅到位');
process.exit(0);
