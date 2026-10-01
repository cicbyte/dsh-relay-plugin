// 附件下载路由冒烟（只读下载池模型）：dl-create 池外拒绝 + 桌面侧直写池目录
// + dl-pool 列表 + dl/<id>（校验下载）+ dl-pool-delete + dl-list + dl-revoke + Range 断点。
// 安全模型：随机唯一 id、绑定设备（错设备 403）、过期 410、撤销 404、默认 30min/上限 7 天、
// 池外路径一律 403、手机无入池原语（dl-stage 已移除）、workspace-list 只列目录。
// 用法：node test/download-smoke.mjs
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

// DSH_HOME 指到临时目录：全局池不污染真实 ~/.dsh（须在导入 impl.js 前设好）
const TEST_HOME = path.join(process.cwd(), 'test-dl-home-tmp');
// 清场（上次失败提前退出可能留下池文件，保证断言幂等）
for (const d of [TEST_HOME, path.join(process.cwd(), '.dsh-download')]) {
  try { rmSync(d, { recursive: true, force: true }); } catch {}
}
process.env.DSH_HOME = TEST_HOME;
const { apply } = await import('../lib/impl.js');

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

function req(method, url, { body, deviceId, headers, remoteAddress = '127.0.0.1' } = {}) {
  const r = {
    method, url,
    socket: { remoteAddress },
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
const jsonOf = (r) => JSON.parse(r.body);
const resultOf = (r) => jsonOf(r).result;

const DEV = 'dev_test_abc';
const WS = process.cwd(); // 模拟会话 cwd（工作区）
const WS_POOL = path.join(WS, '.dsh-download');
const GLOBAL_POOL = path.join(TEST_HOME, '.dsh-download');

/** 模拟桌面侧入池：直接往池目录写文件（只读池模型——手机没有入池原语）。 */
const putPool = (dir, name, content) => {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
};

// 造池外临时测试文件（dl-create 应拒绝）
const tmp = path.join(WS, 'test-dl-tmp.txt');
writeFileSync(tmp, 'hello download');

// 0. 非环回 → 403（安全栅栏）
const remote = await new Promise((resolve) => {
  let resolved = false;
  const done = (v) => { if (!resolved) { resolved = true; resolve(v); } };
  const res = {
    _body: '',
    writeHead(code, h) { this._code = code; },
    end(s) { if (s) this._body += s; done({ code: this._code, body: this._body }); },
  };
  handler(req('GET', '/mobile-bridge/dl-pool', { remoteAddress: '192.168.1.9' }), res);
});
assert(jsonOf(remote).code === 403, '非环回访问 403');

// 1. 池外文件 dl-create → 拒绝（只读池模型核心边界）
const denied = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: tmp, expiresInSec: 600, deviceId: DEV, workspaceRoot: WS }),
});
assert(jsonOf(denied).code === 403, '池外路径 dl-create 拒绝（403）');
assert(String(jsonOf(denied).message).includes('下载池'), '拒绝原因提示下载池');

// 2. 入池原语已移除（只读池：手机端不该有任何写池路由；兜底 404 空响应）
const stageGone = await call('POST', '/mobile-bridge/dl-stage', {
  body: JSON.stringify({ path: tmp, deviceId: DEV, workspaceRoot: WS, target: 'workspace' }),
});
assert(stageGone.code !== 200, 'dl-stage 路由已移除（非 200）');
const progGone = await call('GET', '/mobile-bridge/dl-stage-progress?id=whatever');
assert(progGone.code !== 200, 'dl-stage-progress 路由已移除（非 200）');

// 3. 桌面侧直写工作区池（入池的唯一途径）
const poolFile = putPool(WS_POOL, 'test-dl-tmp.txt', 'hello download');

// 4. workspace-list 只列目录不列文件（手机不拿全盘文件名枚举）
const ls = resultOf(await call('GET', `/mobile-bridge/workspace-list?path=${encodeURIComponent(WS)}`));
assert(ls.ok === true && Array.isArray(ls.dirs), 'workspace-list 200');
assert(ls.files === undefined, 'workspace-list 不返回 files（枚举已收）');

// 5. dl-pool 列表：工作区池 + 全局池
const pool = resultOf(await call('GET', `/mobile-bridge/dl-pool?workspace=${encodeURIComponent(WS)}`));
assert(pool.workspace.dir === WS_POOL, `工作区池目录=${WS_POOL}`);
assert(pool.global.dir === GLOBAL_POOL, `全局池目录=${GLOBAL_POOL}`);
assert(pool.items.some((f) => f.name === 'test-dl-tmp.txt' && f.pool === 'workspace'), '池列表含池内文件');

// 6. 池内文件 dl-create（带 workspaceRoot）→ 200 随机 id
const c = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: poolFile, expiresInSec: 600, deviceId: DEV, workspaceRoot: WS }),
});
assert(c.code === 200, '池内文件 dl-create 200');
const dl = resultOf(c);
assert(typeof dl.downloadId === 'string' && dl.downloadId.length >= 16, `随机 downloadId=${dl.downloadId.slice(0, 8)}…`);
assert(dl.ttl === 600, '有效期 600s 生效');

// 7. 正确设备下载 → 流式
const ok = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=${DEV}`);
assert(ok.streamed === true, '正确设备下载流式返回');
assert(ok.body === 'hello download', '内容完整（池内副本）');

// 8. 错误设备 → 403；随机不存在 id → 404
const bad = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=wrong_device`);
assert(jsonOf(bad).code === 403, '错误设备 403');
const noent = await call('GET', `/mobile-bridge/dl/nonexist123?d=${DEV}`);
assert(jsonOf(noent).code === 404, '不存在 id 404');

// 9. 超上限有效期被钳到 7 天
const cap = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: poolFile, expiresInSec: 99999999, deviceId: DEV, workspaceRoot: WS }),
});
assert(resultOf(cap).ttl === 7 * 24 * 3600, '有效期钳到 7 天上限');

// 10. dl-list 含链接记录；dl-revoke 撤销
const list = resultOf(await call('GET', '/mobile-bridge/dl-list'));
assert(list.items.length === 2, 'dl-list 列出 2 条');
const rv = await call('POST', '/mobile-bridge/dl-revoke', {
  body: JSON.stringify({ downloadId: dl.downloadId }),
});
assert(jsonOf(rv).code === 200, 'dl-revoke 200');
const after = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=${DEV}`);
assert(jsonOf(after).code === 404, '撤销后 404');

// 11. Range 断点：bytes=0-4 → 206 + Content-Range
const dl2 = resultOf(await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: poolFile, deviceId: DEV, workspaceRoot: WS }),
}));
const rg = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`, {
  headers: { range: 'bytes=0-4' },
});
assert(rg.code === 206, `Range 206（got ${rg.code}）`);
assert(rg.headers['content-range'] === 'bytes 0-4/14', `Content-Range=${rg.headers['content-range']}`);
assert(rg.body === 'hello', `Range 0-4 返回="${rg.body}"`);

// 11b. Range 起点越界 → 416 + octet-stream + 0 长度（隧道流式收尾可判定「本地已完整」）
const rg416 = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`, {
  headers: { range: 'bytes=99999-' },
});
assert(rg416.code === 416, `Range 越界 416（got ${rg416.code}）`);
assert(rg416.headers['content-type'] === 'application/octet-stream', '416 带 octet-stream（流式接管）');
assert(rg416.headers['content-length'] === '0', '416 零长度');

// 12. 非法文件名删除 → 拒绝（防路径穿越）
const evil = await call('POST', '/mobile-bridge/dl-pool-delete', {
  body: JSON.stringify({ name: '..\\evil.txt', pool: 'global', deviceId: DEV }),
});
assert(jsonOf(evil).code === 400, '路径穿越文件名删除 400');

// 13. 删除池内文件 → 旧链接 410（文件已不存在）
const del = await call('POST', '/mobile-bridge/dl-pool-delete', {
  body: JSON.stringify({ name: 'test-dl-tmp.txt', pool: 'workspace', workspaceRoot: WS, deviceId: DEV }),
});
assert(jsonOf(del).code === 200, 'dl-pool-delete 200');
const gone = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`);
assert(jsonOf(gone).code === 410, '删池后旧链接 410（文件已不存在）');

// 14. 全局池（无 workspaceRoot）：桌面侧直写 → 无工作区也能 dl-create
const gFile = putPool(GLOBAL_POOL, 'global-dl.txt', 'hello global');
const gdRaw = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: gFile, deviceId: DEV }),
});
assert(jsonOf(gdRaw).code === 200, '全局池文件 dl-create（无 workspaceRoot）200');

// 清理：临时文件 + 池目录 + 测试 DSH_HOME
for (const f of [tmp, gFile]) {
  try { rmSync(f, { force: true }); } catch {}
}
try { rmSync(WS_POOL, { recursive: true, force: true }); } catch {}
try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
console.log('[download-smoke] PASS：只读池（stage 移除）+ 池外 403 + 桌面侧入池 + 池列表 + 设备绑定 + 7天上限 + 撤销 + Range 206 + 池删除 + 全局池 + 列目录不列文件');
process.exit(0);
