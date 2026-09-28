// lib/entry.js —— 热激活壳（终态）。
//
// loader 的 import 记忆化按 URL 命中：同名 entry 重建只拿到缓存旧模块，改 impl.js
// 不换 URL 永远不生效（2026-10-01 实锤：launch-token 路由 404 半天查不出）。
// 本壳每次 apply 都以时间戳 query 动态导入 impl.js——query 变 = URL 变 = 永远绕开
// 记忆化。此后改服务端半只需重启本 entry（行开关 toggle 或补丁摘除/重插），免换包。
//
// Config 内联导出：schema 稳定少改；loader/设置服务同步读取 runtime.Config，
// 不能等异步导入（impl.js 的同名导出与此保持一致，改 schema 两处同步）。
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

// 壳落地痕迹（诊断用，与 impl.js 同一 trace 文件）：证明 loader 真走了壳、
// 以及 shell 级失败（此前壳级异常静默不落地，trace 里只见 apply called 缺
// "module imported (impl)"，怀疑半天无证据）。
const shellTrace = (line) => {
  try {
    const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
    appendFileSync(path.join(home, 'mobile-bridge-applied.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
};

export const Config = z.object({
  relayUrl: z.string().default('ws://127.0.0.1:8787').volatile(),
  code: z.string().default('').volatile(),
  dshUrl: z.string().default('http://127.0.0.1:3080').volatile(),
  pairingCode: z.string().default('').volatile(),
});

export async function apply(ctx, config) {
  shellTrace('entry apply called (shell)');
  // Config 内联已在 loader 侧生效；impl.js 异步落地不阻塞 fiber
  const mod = await import(`./impl.js?t=${Date.now()}`);
  shellTrace('entry impl imported (shell)');
  try {
    return await mod.apply(ctx, config);
  } catch (e) {
    shellTrace(`entry impl.apply FAILED (shell): ${(e && e.stack) || e}`);
    throw e;
  }
}
