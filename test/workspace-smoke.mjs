// 工作区路由冒烟：workspace-roots（多盘符/单根+配置快路径）+ workspace-list（列子目录/隐藏过滤）。
// 用法：node test/workspace-smoke.mjs
import { apply } from '../lib/impl.js';

const calls = { routes: [] };
const fakeWebServer = { register(row) { calls.routes.push(row); return () => {}; } };
const ctx = {
  logger: () => ({ info() {}, error() {} }),
  get(name) { return name === 'webServer' ? { webServer: fakeWebServer } : undefined; },
  inject(deps, cb) { cb({ webServer: fakeWebServer, effect: (fn) => fn() }); },
  on() {},
  effect(fn) { return fn(); },
};

const assert = (cond, label) => {
  if (!cond) { console.error('FAIL:', label); process.exit(1); }
  console.log('ok:', label);
};

apply(ctx, { workspacePaths: `${process.cwd()},${process.env.HOME || process.env.USERPROFILE}` });

// 取到 serveStatus handler（注册的 prefix 路由）
const handler = calls.routes.find((r) => r.path === '/mobile-bridge')?.handler;
assert(typeof handler === 'function', 'workspace 路由随 serveStatus 注册');

function fakeReq(url) {
  return { method: 'GET', url, socket: { remoteAddress: '127.0.0.1' } };
}
function call(url) {
  return new Promise((resolve) => {
    const res = {
      _body: '',
      writeHead() {},
      end(s) { this._body = s; resolve(JSON.parse(s)); },
    };
    handler(fakeReq(url), res);
  });
}

// workspace-roots
const roots = await call('/mobile-bridge/workspace-roots');
assert(roots.code === 200, 'workspace-roots 200');
assert(Array.isArray(roots.result.quick) && roots.result.quick.length >= 1, `快路径含配置的 ${roots.result.quick.length} 条`);
assert(Array.isArray(roots.result.roots) && roots.result.roots.length >= 1, `根含 ${roots.result.roots.length} 个（多盘符并列/单根）`);
assert(typeof roots.result.platform === 'string', `platform=${roots.result.platform}`);

// workspace-list（列当前工作区的子目录）
const cwd = process.cwd();
const list = await call(`/mobile-bridge/workspace-list?path=${encodeURIComponent(cwd)}`);
assert(list.code === 200, 'workspace-list 200');
assert(Array.isArray(list.result.dirs), `子目录 ${list.result.dirs.length} 个`);
assert(!list.result.dirs.some((d) => d.label.startsWith('.')), '默认隐藏点开头目录');

// 隐藏过滤开关
const listHidden = await call(`/mobile-bridge/workspace-list?path=${encodeURIComponent(cwd)}&hidden=1`);
assert(listHidden.code === 200 && listHidden.result.dirs.length >= list.result.dirs.length, 'hidden=1 不过滤隐藏目录');

// 非法路径
const bad = await call('/mobile-bridge/workspace-list?path=/nonexistent-dir-xyz');
assert(bad.code === 400, '非法路径返回 400');

console.log('[workspace-smoke] PASS：workspace-roots + workspace-list 跨平台 + 隐藏过滤 + 非法路径');
process.exit(0);
