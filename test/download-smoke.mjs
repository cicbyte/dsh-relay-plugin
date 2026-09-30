// 附件下载路由冒烟（下载池模型）：dl-create 池外拒绝 + dl-stage 入池 + dl-pool 列表
// + dl/<id>（校验下载）+ dl-pool-delete + dl-list + dl-revoke + Range 断点。
// 安全模型：随机唯一 id、绑定设备（错设备 403）、过期 410、撤销 404、默认 30min/上限 7 天、
// 池外路径一律 403（即使手机端被绕过也下不了任意磁盘文件）。
// 用法：node test/download-smoke.mjs
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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

/** 等待入池复制完成（轮询 dl-stage-progress），返回最终进度。 */
async function waitStage(taskId, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = resultOf(await call('GET', `/mobile-bridge/dl-stage-progress?id=${encodeURIComponent(taskId)}`));
    if (r && r.done) return r;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`stage 复制超时 (${ms}ms)`);
}

// 造池外临时测试文件
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

// 1. 池外文件 dl-create → 拒绝（下载池模型核心边界）
const denied = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: tmp, expiresInSec: 600, deviceId: DEV, workspaceRoot: WS }),
});
assert(jsonOf(denied).code === 403, '池外路径 dl-create 拒绝（403）');
assert(String(jsonOf(denied).message).includes('下载池'), '拒绝原因提示下载池');

// 2. dl-stage 入工作区池（异步复制：立即返回 taskId，轮询进度到 done）
const staged = await call('POST', '/mobile-bridge/dl-stage', {
  body: JSON.stringify({ path: tmp, deviceId: DEV, workspaceRoot: WS, target: 'workspace' }),
});
assert(jsonOf(staged).code === 200, 'dl-stage 200（异步，立即返回）');
const st = resultOf(staged);
assert(typeof st.taskId === 'string' && st.taskId.length >= 8, `taskId=${st.taskId.slice(0, 8)}…`);
const prog = await waitStage(st.taskId);
assert(prog.done === true && !prog.error, '复制完成（done）');
assert(prog.copied === 14 && prog.total === 14, `进度 copied=total=14（got ${prog.copied}/${prog.total}）`);
assert(st.name === 'test-dl-tmp.txt' && st.pool === 'workspace', `入工作区池 name=${st.name}`);
assert(st.size === 14, '入池副本大小 14');
assert(existsSync(tmp), '原文件保留（复制非移动）');
// 进度任务完成后仍可查询（终态保留 10min）
const prog2 = resultOf(await call('GET', `/mobile-bridge/dl-stage-progress?id=${encodeURIComponent(st.taskId)}`));
assert(prog2.done === true, '完成态进度可复查');
// 未知任务 → 404
const noTask = await call('GET', '/mobile-bridge/dl-stage-progress?id=nonexistent');
assert(jsonOf(noTask).code === 404, '未知任务 404');

// 3. dl-pool 列表：工作区池 + 全局池
const pool = resultOf(await call('GET', `/mobile-bridge/dl-pool?workspace=${encodeURIComponent(WS)}`));
assert(pool.workspace.dir === WS_POOL, `工作区池目录=${WS_POOL}`);
assert(pool.global.dir === GLOBAL_POOL, `全局池目录=${GLOBAL_POOL}`);
assert(pool.items.some((f) => f.name === 'test-dl-tmp.txt' && f.pool === 'workspace'), '池列表含入池文件');

// 4. 池内文件 dl-create（带 workspaceRoot）→ 200 随机 id
const c = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: st.path, expiresInSec: 600, deviceId: DEV, workspaceRoot: WS }),
});
assert(c.code === 200, '池内文件 dl-create 200');
const dl = resultOf(c);
assert(typeof dl.downloadId === 'string' && dl.downloadId.length >= 16, `随机 downloadId=${dl.downloadId.slice(0, 8)}…`);
assert(dl.ttl === 600, '有效期 600s 生效');

// 5. 正确设备下载 → 流式
const ok = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=${DEV}`);
assert(ok.streamed === true, '正确设备下载流式返回');
assert(ok.body === 'hello download', '内容完整（池内副本）');

// 6. 错误设备 → 403；随机不存在 id → 404
const bad = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=wrong_device`);
assert(jsonOf(bad).code === 403, '错误设备 403');
const noent = await call('GET', `/mobile-bridge/dl/nonexist123?d=${DEV}`);
assert(jsonOf(noent).code === 404, '不存在 id 404');

// 7. 超上限有效期被钳到 7 天
const cap = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: st.path, expiresInSec: 99999999, deviceId: DEV, workspaceRoot: WS }),
});
assert(resultOf(cap).ttl === 7 * 24 * 3600, '有效期钳到 7 天上限');

// 8. 同名再入池 → 自动加 (1) 后缀（wx 原子占位，复制进行中也不重名）
const staged2 = resultOf(await call('POST', '/mobile-bridge/dl-stage', {
  body: JSON.stringify({ path: tmp, deviceId: DEV, workspaceRoot: WS, target: 'workspace' }),
}));
assert(staged2.name === 'test-dl-tmp (1).txt', `同名冲突自动后缀=${staged2.name}`);
await waitStage(staged2.taskId);

// 9. dl-list 含链接记录；dl-revoke 撤销
const list = resultOf(await call('GET', '/mobile-bridge/dl-list'));
assert(list.items.length === 2, 'dl-list 列出 2 条');
const rv = await call('POST', '/mobile-bridge/dl-revoke', {
  body: JSON.stringify({ downloadId: dl.downloadId }),
});
assert(jsonOf(rv).code === 200, 'dl-revoke 200');
const after = await call('GET', `/mobile-bridge/dl/${dl.downloadId}?d=${DEV}`);
assert(jsonOf(after).code === 404, '撤销后 404');

// 10. Range 断点：bytes=0-4 → 206 + Content-Range
const dl2 = resultOf(await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: st.path, deviceId: DEV, workspaceRoot: WS }),
}));
const rg = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`, {
  headers: { range: 'bytes=0-4' },
});
assert(rg.code === 206, `Range 206（got ${rg.code}）`);
assert(rg.headers['content-range'] === 'bytes 0-4/14', `Content-Range=${rg.headers['content-range']}`);
assert(rg.body === 'hello', `Range 0-4 返回="${rg.body}"`);

// 10b. Range 起点越界 → 416 + octet-stream + 0 长度（隧道流式收尾可判定「本地已完整」）
const rg416 = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`, {
  headers: { range: 'bytes=99999-' },
});
assert(rg416.code === 416, `Range 越界 416（got ${rg416.code}）`);
assert(rg416.headers['content-type'] === 'application/octet-stream', '416 带 octet-stream（流式接管）');
assert(rg416.headers['content-length'] === '0', '416 零长度');

// 11. 非法文件名删除 → 拒绝（防路径穿越）
const evil = await call('POST', '/mobile-bridge/dl-pool-delete', {
  body: JSON.stringify({ name: '..\\evil.txt', pool: 'global', deviceId: DEV }),
});
assert(jsonOf(evil).code === 400, '路径穿越文件名删除 400');

// 12. 删除池内文件 → 旧链接 410（文件已不存在）
const del = await call('POST', '/mobile-bridge/dl-pool-delete', {
  body: JSON.stringify({ name: 'test-dl-tmp.txt', pool: 'workspace', workspaceRoot: WS, deviceId: DEV }),
});
assert(jsonOf(del).code === 200, 'dl-pool-delete 200');
const gone = await call('GET', `/mobile-bridge/dl/${dl2.downloadId}?d=${DEV}`);
assert(jsonOf(gone).code === 410, '删池后旧链接 410（文件已不存在）');

// 13. 入全局池（无 workspaceRoot）
const g = resultOf(await call('POST', '/mobile-bridge/dl-stage', {
  body: JSON.stringify({ path: staged2.path, deviceId: DEV, target: 'global' }),
}));
await waitStage(g.taskId);
assert(g.pool === 'global' && path.dirname(g.path) === GLOBAL_POOL, '入全局池');
// 全局池文件无需 workspaceRoot 也能 dl-create
const gdRaw = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: g.path, deviceId: DEV }),
});
assert(jsonOf(gdRaw).code === 200, '全局池文件 dl-create（无 workspaceRoot）200');

// 清理：临时文件 + 池目录 + 测试 DSH_HOME
for (const f of [tmp, path.join(WS_POOL, 'test-dl-tmp (1).txt'), g.path]) {
  try { rmSync(f, { force: true }); } catch {}
}
try { rmSync(WS_POOL, { recursive: true, force: true }); } catch {}
try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
console.log('[download-smoke] PASS：池外 403 + 入池复制 + 池列表 + 设备绑定 + 7天上限 + 撤销 + Range 206 + 池删除 + 全局池');
process.exit(0);
