// DSH 云端转发桌面桥（v1）——可复用核心 + 独立运行入口。
//
//   relay(公网) ←─ WS(dsh-relay-v1) ─→ 本桥 ─→ http://127.0.0.1:3080（dsh web）
//
// 职责（协议与 relay/relay-server 的 dsh-relay-v1 帧对齐）：
//   - 以 role=host 连接 relay（共享配对码），断线指数退避自动重连（单飞）；
//   - http-req → fetch 到本机 dsh web → http-res（只透传 cookie/content-type/
//     accept/authorization，Host 固定 loopback 以过 DSH 信任栅栏，setCookie 回传）；
//   - ws-open → 连本机 WS 端点（如 /api/remote.mux），双向泵 ws-frame；
//     开隧道回复 `__open__` 哨兵帧；同 rid 幂等重开（先拆旧隧道）；
//   - peer{online:false} 拆除全部隧道；ping/pong 应答保活。
//
// 配置（优先级从高到低）：显式 config > 环境变量 > $DSH_HOME/mobile-bridge.json：
//   relayUrl: relay 的 ws(s) 地址   （env RELAY_URL，缺省 ws://127.0.0.1:8787）
//   code:     ≥6 位配对码           （env RELAY_CODE，必填）
//   dshUrl:   本机 dsh web 地址     （env DSH_URL，缺省 http://127.0.0.1:3080）
//
// 独立运行（不经 dsh，调试用）：node lib/bridge.js

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const OPEN = WebSocket.OPEN;

/** 合并 entry config / 环境变量 / $DSH_HOME/mobile-bridge.json。 */
export function resolveConfig(entryConfig = {}) {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  let fileConfig = {};
  const file = entryConfig.configFile || path.join(home, 'mobile-bridge.json');
  try {
    fileConfig = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // 配置文件可缺省
  }
  const pick = (key, envKey, fallback) =>
    entryConfig[key] || process.env[envKey] || fileConfig[key] || fallback;
  return {
    relayUrl: pick('relayUrl', 'RELAY_URL', 'ws://127.0.0.1:8787'),
    code: pick('code', 'RELAY_CODE', ''),
    dshUrl: String(pick('dshUrl', 'DSH_URL', 'http://127.0.0.1:3080')).replace(/\/+$/, ''),
  };
}

export class MobileBridge {
  /**
   * @param {{relayUrl: string, code: string, dshUrl: string}} config
   * @param {{info(msg: string): void, error(msg: string): void}} [logger]
   */
  constructor(config, logger) {
    this.config = config;
    this.log = logger ?? {
      info: (m) => console.log(`[mobile-bridge] ${m}`),
      error: (m) => console.error(`[mobile-bridge] ${m}`),
    };
    this.ws = null;
    this.closed = false;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.started = false;
    this.connected = false;
    this.peerOnline = false;
    this.since = null;
    this.tunnels = new Map(); // rid → WebSocket
  }

  start() {
    const { code, relayUrl, dshUrl } = this.config;
    if (!code || code.length < 6) {
      this.log.error('配对码（code / RELAY_CODE）未设置或过短（手机端必须输入同一配对码），桥未启动');
      return;
    }
    this.closed = false;
    this.started = true;
    this.log.info(`dsh=${dshUrl} relay=${relayUrl}`);
    this.#connect();
  }

  /** 换配置热重启（UI 保存 / settings 更新时调用）：拆旧连接再按新配置起。 */
  update(config) {
    const was = this.started;
    this.close();
    this.config = config;
    if (was) this.start();
  }

  /** 桥状态快照（设置页「手机通道」轮询；不含配对码明文）。 */
  status() {
    return {
      connected: this.connected,
      peerOnline: this.peerOnline,
      tunnels: this.tunnels.size,
      started: this.started,
      since: this.since,
      relayUrl: this.config.relayUrl,
      dshUrl: this.config.dshUrl,
      codeSet: !!(this.config.code && this.config.code.length >= 6),
    };
  }

  close() {
    this.closed = true;
    this.started = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.#closeAllTunnels('bridge-closed');
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
  }

  #send(obj) {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(obj));
  }

  #connect() {
    const ws = new WebSocket(this.config.relayUrl, 'dsh-relay-v1');
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelay = 1000;
      this.connected = true;
      this.since = new Date().toISOString();
      this.#send({ type: 'hello', role: 'host', code: this.config.code });
      this.log.info('connected to relay');
    });

    ws.on('message', (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString('utf8'));
      } catch {
        return;
      }
      switch (frame.type) {
        case 'welcome':
          this.peerOnline = !!frame.peerOnline;
          this.log.info(`welcomed (peerOnline=${frame.peerOnline})`);
          return;
        case 'ping':
          this.#send({ type: 'pong', t: frame.t });
          return;
        case 'bye':
          this.log.info(`relay bye: ${frame.code}`);
          try {
            ws.close();
          } catch {}
          return;
        case 'peer':
          this.peerOnline = !!frame.online;
          this.log.info(`phone ${frame.online ? 'online' : 'offline'}`);
          if (!frame.online) this.#closeAllTunnels('peer-offline');
          return;
        case 'http-req':
          return this.#handleHttp(frame);
        case 'ws-open':
          return this.#handleWsOpen(frame);
        case 'ws-frame':
          return this.#handleWsFrame(frame);
        case 'ws-close':
          return this.#handleWsClose(frame);
        case 'reject':
          this.log.error(`rejected: ${frame.code}`);
          return;
        default:
          return;
      }
    });

    ws.on('close', () => {
      this.connected = false;
      this.peerOnline = false;
      this.#closeAllTunnels('relay-disconnected');
      if (this.closed) return;
      this.reconnectTimer = setTimeout(() => this.#connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
      this.log.info('relay disconnected, reconnecting...');
    });
    ws.on('error', (e) => this.log.error(`ws error: ${e?.message || e}`));
  }

  async #handleHttp(frame) {
    const { rid, method = 'GET', path: reqPath = '/', body, headers = {} } = frame;
    try {
      const url = new URL(reqPath, this.config.dshUrl + '/');
      const reqHeaders = {};
      for (const [k, v] of Object.entries(headers || {})) {
        const lk = k.toLowerCase();
        if (['cookie', 'content-type', 'accept', 'authorization'].includes(lk)) reqHeaders[lk] = v;
      }
      const resp = await fetch(url, {
        method,
        headers: reqHeaders,
        body: body === undefined || body === null ? undefined : String(body),
        redirect: 'manual',
      });
      const text = await resp.text();
      this.#send({
        type: 'http-res',
        rid,
        status: resp.status,
        body: text,
        setCookie: resp.headers.getSetCookie ? resp.headers.getSetCookie() : [],
      });
    } catch (e) {
      this.#send({ type: 'error', rid, code: 'bridge-http-failed', message: String(e?.message || e) });
    }
  }

  #handleWsOpen(frame) {
    const { rid, path: reqPath = '/', headers = {} } = frame;
    // 幂等重开：同 rid 先拆旧隧道（避免残留隧道吞掉后续 open）
    if (this.tunnels.has(rid)) {
      try {
        this.tunnels.get(rid).close();
      } catch {}
      this.tunnels.delete(rid);
    }
    const target = this.config.dshUrl.replace(/^http/, 'ws') + reqPath;
    const t = new WebSocket(target, { headers: { cookie: headers.cookie || '' } });
    this.tunnels.set(rid, t);
    t.on('open', () => this.#send({ type: 'ws-frame', rid, text: '__open__' }));
    t.on('message', (data, isBinary) => {
      if (isBinary) return; // dsh mux 均为文本帧
      this.#send({ type: 'ws-frame', rid, text: data.toString('utf8') });
    });
    t.on('close', () => {
      this.tunnels.delete(rid);
      this.#send({ type: 'ws-close', rid });
    });
    t.on('error', (e) => {
      this.#send({ type: 'error', rid, code: 'bridge-ws-failed', message: String(e?.message || e) });
      this.tunnels.delete(rid);
      try {
        t.close();
      } catch {}
    });
  }

  #handleWsFrame(frame) {
    const t = this.tunnels.get(frame.rid);
    if (t && t.readyState === OPEN) t.send(frame.text);
  }

  #handleWsClose(frame) {
    const t = this.tunnels.get(frame.rid);
    if (t) {
      this.tunnels.delete(frame.rid);
      try {
        t.close();
      } catch {}
    }
  }

  #closeAllTunnels(reason) {
    for (const [rid, t] of this.tunnels) {
      this.log.info(`close tunnel ${rid} (${reason})`);
      try {
        t.close();
      } catch {}
    }
    this.tunnels.clear();
  }
}

// ---------- 独立运行入口：node lib/bridge.js ----------
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const bridge = new MobileBridge(resolveConfig());
  bridge.start();
  process.on('SIGINT', () => {
    bridge.close();
    process.exit(0);
  });
}
