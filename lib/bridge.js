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

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, networkInterfaces } from 'node:os';
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
    // hello v2 设备身份：优先令牌重连，其次一次性配对码（首次）
    deviceId: pick('deviceId', 'RELAY_DEVICE_ID', ''),
    token: pick('token', 'RELAY_DEVICE_TOKEN', ''),
    pairingCode: pick('pairingCode', 'RELAY_PAIRING_CODE', ''),
    name: pick('name', 'RELAY_DEVICE_NAME', `bridge-${hostname()}`),
    adminUrl: pick('adminUrl', 'RELAY_ADMIN_URL', ''),
    configFile: file,
  };
}

/** 本机局域网 IPv4（dshlan:// 出码用；多网卡取首个非回环，无则回退 127.0.0.1）。 */
export function lanAddress() {
  try {
    const ifs = networkInterfaces() ?? {};
    for (const list of Object.values(ifs)) {
      for (const it of list ?? []) {
        if (it && (it.family === 'IPv4' || it.family === 4) && !it.internal) return it.address;
      }
    }
  } catch {}
  return '127.0.0.1';
}

/** relay ws 地址 → 管理面地址（ws://h:8787 → http://h:8788；可被 adminUrl 覆盖）。 */export function deriveAdminUrl(relayUrl) {
  try {
    const u = new URL(relayUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    if (!u.port || u.port === '8787') u.port = '8788';
    u.pathname = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return 'http://127.0.0.1:8788';
  }
}

/** 配对成功后把设备凭据落盘（只写回 JSON 文件，不碰其他来源）。 */
function persistCredentials(configFile, deviceId, token) {
  try {
    let cur = {};
    try {
      cur = JSON.parse(readFileSync(configFile, 'utf8'));
    } catch {}
    cur.deviceId = deviceId;
    cur.token = token;
    writeFileSync(configFile, JSON.stringify(cur, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}

/** 凭据类拒绝（需要人工换码/重配对，不能快速重连刷屏） */
const CREDENTIAL_REJECTS = new Set([
  'auth-required', 'bad-token', 'revoked', 'unknown-device',
  'pairing-invalid', 'pairing-expired', 'pairing-used', 'pairing-burned',
  'room-mismatch', 'role-mismatch', 'bad-code', 'bad-hello', 'bad-role',
]);

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
      clientCount: this.clientCount ?? 0,
      tunnels: this.tunnels.size,
      started: this.started,
      since: this.since,
      relayUrl: this.config.relayUrl,
      dshUrl: this.config.dshUrl,
      codeSet: !!(this.config.code && this.config.code.length >= 6),
      paired: !!(this.config.deviceId && this.config.token),
      deviceId: this.config.deviceId || '',
      lastReject: this.lastReject || '',
    };
  }

  /**
   * 设备代领配对码：用本桥的 host 设备令牌向 relay 签发 role=client 配对码
   * （免管理台，供设置页二维码给手机扫码）。
   * @returns {Promise<{code: string, room: string, expiresAt: number}>}
   */
  async inviteCode(name = '') {
    if (!this.config.deviceId || !this.config.token) throw new Error('桥尚未配对（无设备令牌），请先完成 Host 配对');
    const admin = this.config.adminUrl || deriveAdminUrl(this.config.relayUrl);
    const res = await fetch(`${admin}/api/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.config.token}`,
        'x-device-id': this.config.deviceId,
      },
      body: JSON.stringify({ name }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.code !== 200) throw new Error(j.message || `邀请失败 HTTP ${res.status}`);
    return j.result;
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
      this.connected = true;
      this.since = new Date().toISOString();
      // hello v2：令牌优先（已配对重连），其次一次性配对码（首次），裸 code 仅供 code 模式兼容
      // 设备凭证（token/pairingCode）模式下**不带 code**：服务端把 code 哈希
      // 当房间主张，绑房间的配对码/设备记录才是权威（带 room-id 当 code 会误报
      // room-mismatch）。code 仅旧共享码模式（AUTH_MODE=code）使用。
      const hello = { type: 'hello', role: 'host', name: this.config.name };
      if (this.config.deviceId && this.config.token) {
        hello.deviceId = this.config.deviceId;
        hello.token = this.config.token;
      } else if (this.config.pairingCode) {
        hello.pairingCode = this.config.pairingCode;
      } else if (this.config.code) {
        hello.code = this.config.code;
      }
      this.#send(hello);
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
          // 拿到 welcome 才算握手成功，此刻才重置退避（open 即重置是旧版风暴根因）
          this.reconnectDelay = 1000;
          this.peerOnline = !!frame.peerOnline;
          if (frame.clients != null) this.clientCount = frame.clients;
          if (frame.device?.token) {
            // 首次配对：一次性令牌落盘，后续走令牌重连
            this.config.deviceId = frame.device.id;
            this.config.token = frame.device.token;
            this.config.pairingCode = '';
            const ok = persistCredentials(this.config.configFile, frame.device.id, frame.device.token);
            this.log.info(`paired as device ${frame.device.id}（令牌${ok ? '已落盘' : '落盘失败'}）`);
          }
          this.log.info(`welcomed (auth=${frame.auth || 'code'} peerOnline=${frame.peerOnline} clients=${frame.clients ?? '?'})`);
          return;
        case 'ping':
          this.#send({ type: 'pong', t: frame.t });
          return;
        case 'bye':
          this.log.info(`relay bye: ${frame.code}`);
          if (frame.code === 'revoked') {
            // 设备已被管理台吊销：慢速自愈，等管理员重配对/轮换
            this.log.error('设备已被吊销（revoked），请在管理台重新生成配对码或轮换令牌');
            this.reconnectDelay = Math.max(this.reconnectDelay, 30_000);
          }
          try {
            ws.close();
          } catch {}
          return;
        case 'peer':
          this.peerOnline = !!frame.online;
          if (frame.clients != null) this.clientCount = frame.clients;
          this.log.info(`phone ${frame.online ? 'online' : 'offline'} (clients=${frame.clients ?? '?'})`);
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
          if (CREDENTIAL_REJECTS.has(frame.code)) {
            // 凭据/配置类拒绝：一次性配对码作废，退避拉长（严禁 1/s 风暴刷爆 relay 限流窗口）
            if (String(frame.code).startsWith('pairing-')) this.config.pairingCode = '';
            this.reconnectDelay = Math.max(this.reconnectDelay, 30_000);
            this.lastReject = frame.code;
          }
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
