// lan-qr 出码逻辑自测（等价 /mobile-bridge/lan-qr 路由实现）
import { lanAddress } from '../lib/bridge.js';
import QRCode from 'qrcode';

const code = 'tok_abc123';
const name = 'my-pc';
const port = new URL('http://127.0.0.1:3080').port || '3080';
const host = lanAddress();
const payload = `dshlan://${host}:${port}/?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`;
const qr = await QRCode.toDataURL(payload, { width: 220, margin: 1 });

console.log('payload:', payload);
console.log('qr dataURL prefix:', qr.slice(0, 30), 'len:', qr.length);
if (!payload.startsWith('dshlan://') || !qr.startsWith('data:image/png')) {
  console.error('FAIL');
  process.exit(1);
}
console.log('lan-qr OK');
