// 附件下载路由冒烟：dl-create（设备绑定）+ dl/<id>（校验下载）+ dl-list + dl-revoke。
// 验证安全模型：随机唯一 id、绑定设备（错设备 403）、过期 410、撤销 404、默认 30min/上限 7 天。
// 用法：node test/download-smoke.mjs
import { apply } from '../lib/impl.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';

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

apply(ctx, {});
const handler = calls.routes.find((r) => r.path === '/mobile-bridge')?.handler;
assert(typeof handler === 'function', '下载路由随 serveStatus 注册');

// 造临时测试文件
const tmp = path.join(process.cwd(), 'test-dl-tmp.txt');
writeFileSync(tmp, 'hello download');

function req(method, url, { body, deviceId, headers } = {}) {
  const r = {
    method, url,
    socket: { remoteAddress: '127.0.0.1' },
    headers: { ...(deviceId ? { 'x-device-id': deviceId } : {}), ...(headers || {}) },
    async *[Symbol.asyncIterator]() { if (body) yield body; },
  };
  return r;
}
function call(method, url, opts = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
    const res = {
      _body: '', _headers: {}, _code: 0,
      writeHead(code, h) { this._code = code; Object.assign(this._headers, h || {}); },
      // 兼容 createReadStream().pipe(res)：stream 把 res 当 dest，调 write/end
      write(chunk) { this._body += chunk; return true; },
      on() { return this; },
      once() { return this; },
      emit() { return true; },
      end(s) { if (s) this._body += s; done({ code: this._code, body: this._body, headers: this._headers, streamed: this._headers['content-type'] === 'application/octet-stream' }); },
    };
    handler(req(method, url, opts), res);
  });
}

const DEV = 'dev_test_abc';

// 1. dl-create 绑定设备，生成随机 id
const c = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: tmp, expiresInSec: 600, deviceId: DEV }),
});
assert(c.code === 200, 'dl-create 200');
const dl = JSON.parse(c.body).result;
assert(typeof dl.downloadId === 'string' && dl.downloadId.length >= 16, `随机 downloadId=${dl.downloadId.slice(0, 8)}…`);
assert(dl.ttl === 600, '有效期 600s 生效');

// 2. 正确设备下载 → 流式
const ok = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=${DEV}`);
assert(ok.streamed === true, '正确设备下载流式返回');

// 3. 错误设备 → 403
const bad = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=wrong_device`);
assert(JSON.parse(bad.body).code === 403, '错误设备 403');

// 4. 随机不存在 id → 404
const noent = await call('GET', `/mobile-bridge/dl/nonexist123?d=${DEV}`);
assert(JSON.parse(noent.body).code === 404, '不存在 id 404');

// 5. 超上限有效期被钳到 7 天
const cap = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: tmp, expiresInSec: 99999999, deviceId: DEV }),
});
assert(JSON.parse(cap.body).result.ttl === 7 * 24 * 3600, '有效期钳到 7 天上限');

// 6. dl-list 含 2 条
const list = await call('GET', '/mobile-bridge/dl-list');
assert(JSON.parse(list.body).result.items.length === 2, 'dl-list 列出 2 条');

// 7. dl-revoke 撤销
const rv = await call('POST', '/mobile-bridge/dl-revoke', {
  body: JSON.stringify({ downloadId: dl.downloadId }),
});
assert(JSON.parse(rv.body).code === 200, 'dl-revoke 200');
const after = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=${DEV}`);
assert(JSON.parse(after.body).code === 404, '撤销后 404');

// 8. workspace-list files=1 含文件
const wl = await call('GET', `/mobile-bridge/workspace-list?path=${encodeURIComponent(process.cwd())}&files=1`);
const wlRes = JSON.parse(wl.body).result;
assert(Array.isArray(wlRes.files) && wlRes.files.some((f) => f.label === 'test-dl-tmp.txt'), 'workspace-list files=1 含文件');

// 9. Range 断点：bytes=0-4 → 206 + Content-Range + accept-ranges
const dl2 = JSON.parse((await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: tmp, deviceId: DEV }),
})).body).result;
const rg = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`, {
  headers: { range: 'bytes=0-4' },
});
assert(rg.code === 206, `Range 206（got ${rg.code}）`);
assert(rg.headers['content-range'] === 'bytes 0-4/14', `Content-Range=${rg.headers['content-range']}`);
assert(rg.headers['accept-ranges'] === 'bytes', 'accept-ranges: bytes');
assert(rg.body === 'hello', `Range 0-4 返回="${rg.body}"`);

unlinkSync(tmp);
console.log('[download-smoke] PASS：设备绑定 403 + 404 + 7天上限 + 撤销 + files=1 + Range 断点 206');
process.exit(0);
