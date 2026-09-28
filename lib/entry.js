// lib/entry.js —— 热激活壳（终态）。
//
// loader 的 import 记忆化按 URL 命中：同名 entry 重建只拿到缓存旧模块，改 impl.js
// 不换 URL 永远不生效（2026-10-01 实锤：launch-token 路由 404 半天查不出）。
// 本壳每次 apply 都以时间戳 query 动态导入 impl.js——query 变 = URL 变 = 永远绕开
// 记忆化。此后改服务端半只需重启本 entry（行开关 toggle 或补丁摘除/重插），免换包。
//
// Config 内联导出：schema 稳定少改；loader/设置服务同步读取 runtime.Config，
// 不能等异步导入（impl.js 的同名导出与此保持一致，改 schema 两处同步）。
import z from '@deepseek-ai/schemastery';

export const Config = z.object({
  relayUrl: z.string().default('ws://127.0.0.1:8787').volatile(),
  code: z.string().default('').volatile(),
  dshUrl: z.string().default('http://127.0.0.1:3080').volatile(),
  pairingCode: z.string().default('').volatile(),
});

export async function apply(ctx, config) {
  const mod = await import(`./impl.js?t=${Date.now()}`);
  return mod.apply(ctx, config);
}
