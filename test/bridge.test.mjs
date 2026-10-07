// bridge 协议核心单测（node --test）：fake-relay + fake-dsh 本地起服，
// 覆盖 hello 握手 / http-req 转发回包 / SSRF 路径栅栏。竞态与时序类场景
// （退避重连/superseded/断线收尾）依赖真实时序，留给手工 smoke（download-smoke）。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { MobileBridge } from '../lib/bridge.js';

/** 起一个 fake-relay：记录 hello，回 welcome，把收到的帧推给 onFrame。 */
async function startFakeRelay(onHello, onFrame) {
  const wss = new WebSocketServer({ port: 0 });
  const port = await new Promise((resolve) => {
    wss.on('listening', () => resolve(wss.address().port));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (Array.isArray(msg.frames)) {
        for (const f of msg.frames) onFrame?.(f, ws);
        return;
      }
      if (msg.type === 'hello') {
        onHello?.(msg, ws);
        ws.send(JSON.stringify({ type: 'welcome', role: 'host', batch: true, clients: 0, peerOnline: false }));
      } else {
        onFrame?.(msg, ws);
      }
    });
  });
  return { wss, port, close: () => new Promise((r) => wss.close(r)) };
}

/** fake-dsh：/ok 回 200 JSON，其余 404。 */
async function startFakeDsh() {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pong: true }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

const quietLogger = { info: () => {}, error: () => {} };

test('hello 握手：角色/令牌/resumeFrom/batch 上报，welcome 后就绪', async () => {
  let hello = null;
  let resolveHello;
  const helloP = new Promise((r) => (resolveHello = r));
  const relay = await startFakeRelay((msg) => {
    hello = msg;
    resolveHello();
  });
  const bridge = new MobileBridge({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    dshUrl: 'http://127.0.0.1:1',
    deviceId: 'dev_test',
    token: 'tok_test',
    name: 'bridge-test',
  }, quietLogger);
  try {
    bridge.start();
    await Promise.race([helloP, new Promise((_, rej) => setTimeout(() => rej(new Error('hello 未到达')), 5000))]);
    assert.equal(hello.role, 'host');
    assert.equal(hello.deviceId, 'dev_test');
    assert.equal(hello.token, 'tok_test');
    assert.equal(hello.batch, true);
    assert.ok('resumeFrom' in hello);
    assert.equal(bridge.status().started, true);
  } finally {
    bridge.close();
    await relay.close();
  }
});

test('http-req 转发：桥取 fake-dsh 并回 http-res 帧', async () => {
  const dsh = await startFakeDsh();
  let resolveRes;
  const resP = new Promise((r) => (resolveRes = r));
  let relayWs = null;
  const relay = await startFakeRelay((_msg, ws) => {
    relayWs = ws;
  }, (frame) => {
    if (frame.type === 'http-res' && frame.rid === 'r1') resolveRes(frame);
  });
  const bridge = new MobileBridge({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    dshUrl: dsh.url,
    deviceId: 'dev_test',
    token: 'tok_test',
    name: 'bridge-test',
  }, quietLogger);
  try {
    bridge.start();
    // 等 relay 侧收到 hello（welcome 已发），再投 http-req
    await new Promise((r) => setTimeout(r, 300));
    relayWs.send(JSON.stringify({ type: 'http-req', rid: 'r1', method: 'GET', path: '/ok' }));
    const frame = await Promise.race([resP, new Promise((_, rej) => setTimeout(() => rej(new Error('http-res 未到达')), 5000))]);
    assert.equal(frame.status, 200);
    assert.match(frame.body, /pong/);
  } finally {
    bridge.close();
    await dsh.close();
    await relay.close();
  }
});

test('SSRF 栅栏：协议相对路径 //host 被拒（不发 error 之外的请求）', async () => {
  const dsh = await startFakeDsh();
  let hitDsh = false;
  dsh.server.on('request', (req, res) => {
    if (req.url === '/ok') hitDsh = true;
    res.writeHead(200); res.end();
  });
  let resolveErr;
  const errP = new Promise((r) => (resolveErr = r));
  let relayWs = null;
  const relay = await startFakeRelay((_msg, ws) => {
    relayWs = ws;
  }, (frame) => {
    if (frame.type === 'error' && frame.rid === 'evil') resolveErr(frame);
  });
  const bridge = new MobileBridge({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    dshUrl: dsh.url,
    deviceId: 'dev_test',
    token: 'tok_test',
    name: 'bridge-test',
  }, quietLogger);
  try {
    bridge.start();
    await new Promise((r) => setTimeout(r, 300));
    relayWs.send(JSON.stringify({ type: 'http-req', rid: 'evil', method: 'GET', path: '//evil.invalid/ok' }));
    const frame = await Promise.race([errP, new Promise((_, rej) => setTimeout(() => rej(new Error('error 帧未到达')), 5000))]);
    assert.equal(frame.code, 'bridge-bad-path');
    assert.equal(hitDsh, false, 'SSRF 路径不得触达 dsh');
  } finally {
    bridge.close();
    await dsh.close();
    await relay.close();
  }
});

test('SSRF 栅栏：反斜杠协议相对路径 /\\host 被拒（WHATWG 解析击穿前缀校验的回归用例）', async () => {
  const dsh = await startFakeDsh();
  let hitDsh = false;
  dsh.server.on('request', (req, res) => {
    if (req.url === '/ok') hitDsh = true;
    res.writeHead(200); res.end();
  });
  let resolveErr;
  const errP = new Promise((r) => (resolveErr = r));
  let relayWs = null;
  const relay = await startFakeRelay((_msg, ws) => {
    relayWs = ws;
  }, (frame) => {
    if (frame.type === 'error' && frame.rid === 'bslash') resolveErr(frame);
  });
  const bridge = new MobileBridge({
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    dshUrl: dsh.url,
    deviceId: 'dev_test',
    token: 'tok_test',
    name: 'bridge-test',
  }, quietLogger);
  try {
    bridge.start();
    await new Promise((r) => setTimeout(r, 300));
    // 实际路径字符串 = /\evil.invalid/ok（JSON 传输保留反斜杠字面量）
    relayWs.send(JSON.stringify({ type: 'http-req', rid: 'bslash', method: 'GET', path: '/\\evil.invalid/ok' }));
    const frame = await Promise.race([errP, new Promise((_, rej) => setTimeout(() => rej(new Error('error 帧未到达')), 5000))]);
    assert.equal(frame.code, 'bridge-bad-path');
    assert.equal(hitDsh, false, '反斜杠 SSRF 路径不得触达 dsh');
  } finally {
    bridge.close();
    await dsh.close();
    await relay.close();
  }
});
