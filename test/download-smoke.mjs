// 附件下载路由冒烟（共享文件区模型）：dl-create 池外拒绝 + 桌面侧直写区目录
// + dl-pool 列表 + dl/<id>（校验下载）+ dl-pool-delete + dl-list + dl-revoke + Range 断点
// + share-upload 分块上传（init/chunk/断点续传/offset 409/abort/配额/名字清洗/.part 隔离）。
// 安全模型：随机唯一 id、绑定设备（错设备 403）、过期 410、撤销 404、默认 30min/上限 7 天、
// 区外路径一律 403、手机写只进共享区（分块 .part 暂存）、workspace-list 只列目录。
// 用法：node test/download-smoke.mjs
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

// DSH_HOME 指到临时目录：全局区不污染真实 ~/.dsh（须在导入 impl.js 前设好）
const TEST_HOME = path.join(process.cwd(), 'test-dl-home-tmp');
// 清场（上次失败提前退出可能留下区文件，保证断言幂等）
for (const d of [TEST_HOME, path.join(process.cwd(), '.dsh-share')]) {
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
const WS_POOL = path.join(WS, '.dsh-share');
const GLOBAL_POOL = path.join(TEST_HOME, '.dsh-share');

/** 模拟桌面侧入区：直接往区目录写文件（agent/人操作共享区的真实方式）。 */
const putPool = (dir, name, content) => {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
};

/** base64 一块（手机上传的分块格式）。 */
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

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
assert(String(jsonOf(denied).message).includes('共享文件区'), '拒绝原因提示共享文件区');

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

// 14. 全局区（无 workspaceRoot）：桌面侧直写 → 无工作区也能 dl-create
const gFile = putPool(GLOBAL_POOL, 'global-dl.txt', 'hello global');
const gdRaw = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: gFile, deviceId: DEV }),
});
assert(jsonOf(gdRaw).code === 200, '全局区文件 dl-create（无 workspaceRoot）200');

// ---- 手机上传（share-upload-*）----
// 15. init 校验：超大拒绝 / 名字清洗（穿越 basename 化）/ .part 后缀拒绝
const tooBig = await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'big.bin', size: 600 * 1024 * 1024, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
});
assert(jsonOf(tooBig).code === 400, '单文件超 512MB 拒绝（400）');
const trav = resultOf(await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: '..\\..\\evil.txt', size: 4, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
}));
assert(trav.name === 'evil.txt', `穿越名被 basename 化（got ${trav.name}）`);
await call('POST', '/mobile-bridge/share-upload-abort', { body: JSON.stringify({ uploadId: trav.uploadId }) });
const partName = await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'hack.dshpart', size: 4, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
});
assert(jsonOf(partName).code === 400, '.dshpart 后缀名拒绝');

// 16. 完整上传：init → 两块 chunk → done 落盘 → dl-pool 可见 + 内容一致
const up1 = resultOf(await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'phone-upload.txt', size: 17, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
}));
assert(typeof up1.uploadId === 'string' && up1.uploadId.length >= 8 && up1.offset === 0, `init 返回 uploadId（offset=${up1.offset}）`);
const ck1 = resultOf(await call('POST', `/mobile-bridge/share-upload-chunk?id=${up1.uploadId}&offset=0`, { body: b64('hello upload ') }));
assert(ck1.done === false && ck1.offset === 13, `块1 追加（offset=${ck1.offset}）`);
// 在途 .part 不出现在共享区列表
const midPool = resultOf(await call('GET', `/mobile-bridge/dl-pool?workspace=${encodeURIComponent(WS)}`));
assert(!midPool.items.some((f) => f.name.includes('phone-upload')), '在途 .part 不列入 dl-pool');
assert(!midPool.items.some((f) => f.name.endsWith('.dshpart')), '列表无任何 .part');
const ck2 = resultOf(await call('POST', `/mobile-bridge/share-upload-chunk?id=${up1.uploadId}&offset=13`, { body: b64('zone') }));
assert(ck2.done === true && ck2.name === 'phone-upload.txt', '收满转正（done + 改名落盘）');
assert(readFileSync(ck2.path, 'utf8') === 'hello upload zone', '上传内容一致');

// 17. 断点续传：同名 .part → init 返回接续 offset → 余块传完
const up2a = resultOf(await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'resume.txt', size: 20, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
}));
await call('POST', `/mobile-bridge/share-upload-chunk?id=${up2a.uploadId}&offset=0`, { body: b64('0123456789') });
// 模拟断线：丢弃旧会话句柄，重新 init（同名同大小）
const up2b = resultOf(await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'resume.txt', size: 20, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
}));
assert(up2b.name === 'resume.txt' && up2b.offset === 10, `断点续传 offset=10（got ${up2b.offset}）`);
const ck3 = resultOf(await call('POST', `/mobile-bridge/share-upload-chunk?id=${up2b.uploadId}&offset=10`, { body: b64('abcdefghij') }));
assert(ck3.done === true && readFileSync(ck3.path, 'utf8') === '0123456789abcdefghij', '续传完成内容一致');

// 18. offset 乱序/重放 → 409
const up3 = resultOf(await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'order.txt', size: 10, deviceId: DEV, target: 'workspace', workspaceRoot: WS }),
}));
const wrong = await call('POST', `/mobile-bridge/share-upload-chunk?id=${up3.uploadId}&offset=5`, { body: b64('xxxxx') });
assert(jsonOf(wrong).code === 409, 'offset 不匹配 409');
const up3b = resultOf(await call('POST', `/mobile-bridge/share-upload-chunk?id=${up3.uploadId}&offset=0`, { body: b64('aaaaa') }));
const replay = await call('POST', `/mobile-bridge/share-upload-chunk?id=${up3.uploadId}&offset=0`, { body: b64('aaaaa') });
assert(jsonOf(replay).code === 409, '重放旧 offset 409');

// 19. abort → .part 半成品清除
const ab = await call('POST', '/mobile-bridge/share-upload-abort', { body: JSON.stringify({ uploadId: up3.uploadId }) });
assert(jsonOf(ab).code === 200, 'abort 200');
const abPool = resultOf(await call('GET', `/mobile-bridge/dl-pool?workspace=${encodeURIComponent(WS)}`));
assert(!abPool.items.some((f) => f.name === 'order.txt'), 'abort 后无残留');
assert(!existsSync(path.join(WS_POOL, 'order.txt.dshpart')), 'abort 后 .part 已删');

// 20. 空文件上传：size=0 → init 直接 done 落盘
const up0 = resultOf(await call('POST', '/mobile-bridge/share-upload-init', {
  body: JSON.stringify({ name: 'empty.txt', size: 0, deviceId: DEV, target: 'global' }),
}));
assert(up0.done === true && readFileSync(up0.path, 'utf8') === '', '空文件直接落盘');

// 21. 上传文件可下载（闭环：手机传 → agent 侧目录可见 → 反向也能下载）
const dlUp = await call('POST', '/mobile-bridge/dl-create', {
  body: JSON.stringify({ path: ck2.path, deviceId: DEV, workspaceRoot: WS }),
});
assert(jsonOf(dlUp).code === 200, '上传文件可 dl-create');
const fetchUp = await call('GET', `/mobile-bridge/dl/${resultOf(dlUp).downloadId}?d=${DEV}`);
assert(fetchUp.body === 'hello upload zone', '上传文件可下载（内容一致）');

// 清理：临时文件 + 区目录 + 测试 DSH_HOME
for (const f of [tmp, gFile, up0.path]) {
  try { rmSync(f, { force: true }); } catch {}
}
try { rmSync(WS_POOL, { recursive: true, force: true }); } catch {}
try { rmSync(TEST_HOME, { recursive: true, force: true }); } catch {}
console.log('[download-smoke] PASS：共享区（.dsh-share）+ 池外 403 + 桌面侧入区 + 上传（分块/断点/409/abort/空文件/穿越清洗）+ 池列表 + 设备绑定 + 7天上限 + 撤销 + Range 206 + 池删除 + 全局区 + 列目录不列文件');
process.exit(0);
