// 宿主状态采集（宿主状态看板 v1）——三平台适配器 + 能力协商。
//
// 本模块由 impl.js 的 /mobile-bridge/host-status、/mobile-bridge/window-capture
// 以 `?t=<30s 桶>` 动态导入：编辑本文件 ≤30s 后新请求即拿新代码（免重启宿主）。
// 模块保持无状态（每次导入都是新实例），缓存一律不做或做在调用方。
//
// 通用契约：
//   hostStatus() → { platform, host, capabilities:{processList,windowList,capture},
//                    processes:[{pid, name, memMB, cpuPct, win, title}] }
//     win = 窗口引用（win32: hwnd 数字；darwin: "pid:idx"；linux: 十六进制 winid），
//           无窗口为 null。手机端把它当不透明字符串处理。
//   captureWindow(id, outDir) →
//     { ok:true,  file, name, size } | { ok:false, error, hint? }
//
// 平台与限制：
//   win32  Get-Process（cpu 双采样折算 %）；PrintWindow+PW_RENDERFULLCONTENT，
//          最小化窗口按 placement 尺寸抓缓冲，黑帧自检。
//   darwin ps + System Events 窗口表（需辅助功能权限）；screencapture -R 按窗口
//          矩形截屏（区域截屏：被遮挡部分会截到遮挡物——诚实限制），需屏幕录制权限。
//   linux  ps + wmctrl（X11，需已安装）；import -window 抓窗口（ImageMagick）；
//          Wayland/无头：windowList/capture 能力报 false（协议不允许，非缺陷）。

import { spawn } from 'node:child_process';
import { existsSync, statSync, readdirSync, mkdirSync, writeFileSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { hostname, homedir, platform } from 'node:os';

const TIMEOUT = 15000;

function run(cmd, args, timeout = TIMEOUT) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: '', err: String(e) });
    }
    let out = '';
    let err = '';
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        try { child.kill(); } catch {}
        resolve({ code: -1, out, err: (err ? err + '\n' : '') + 'timeout' });
      }
    }, timeout);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e?.message || e) });
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** PowerShell -EncodedCommand 执行（绕开引号地狱）。重定向 stdout 默认走
 *  OEM 代码页（zh-CN=GBK），中文会变 mojibake——脚本首行强制 UTF-8。 */
function runPS(script, timeout = TIMEOUT) {
  const patched =
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\r\n" +
    script;
  const b64 = Buffer.from(patched, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], timeout);
}

/** 上限保护：带窗口的进程全保留（窗口视图的完整性优先），无窗口的按内存取头部补足。 */
function limitProcs(list, n = 300) {
  const winned = list.filter((p) => p.win != null).sort((a, b) => b.memMB - a.memMB);
  const rest = list.filter((p) => p.win == null).sort((a, b) => b.memMB - a.memMB);
  return [...winned, ...rest.slice(0, Math.max(100, n - winned.length))];
}

// ---------------- win32 ----------------

const WIN_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount
$p1 = @{}
foreach ($p in Get-Process) { $p1[$p.Id] = [double]$p.TotalProcessorTime.TotalSeconds }
Start-Sleep -Milliseconds 400
$out = foreach ($p in Get-Process) {
  $c2 = 0.0
  if ($p1.ContainsKey($p.Id)) { $c2 = [double]$p.TotalProcessorTime.TotalSeconds }
  $c1 = 0.0
  if ($p1.ContainsKey($p.Id)) { $c1 = $p1[$p.Id] }
  $pct = [math]::Round((($c2 - $c1) / 0.4 / $cores) * 100, 0)
  [pscustomobject]@{
    pid   = $p.Id
    name  = $p.ProcessName
    memMB = [math]::Round($p.WorkingSet64 / 1MB, 1)
    cpuPct = $pct
    win   = if ($p.MainWindowHandle -ne 0) { [int64]$p.MainWindowHandle } else { $null }
    title = if ($p.MainWindowTitle) { $p.MainWindowTitle } else { '' }
  }
}
@{ procs = @($out); cores = $cores } | ConvertTo-Json -Depth 3 -Compress
`;

export const WIN_CAP_CS = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public class DshCap {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
  [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct WP {
    public uint length; public uint flags; public uint showCmd;
    public PT min; public PT max; public RECT normal;
  }
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WP p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  /** 句柄 → 进程 pid（0=无效句柄）。 */
  public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
  public static string Shot(IntPtr hwnd, string outPath) {
    try {
      if (!IsWindowVisible(hwnd)) return "invisible";
      SetProcessDPIAware();
      RECT r; GetWindowRect(hwnd, out r);
      int w = r.R - r.L; int h = r.B - r.T;
      if (IsIconic(hwnd)) {
        WP wp = new WP(); wp.length = (uint)Marshal.SizeOf(typeof(WP));
        if (!GetWindowPlacement(hwnd, ref wp)) return "minimized";
        w = wp.normal.R - wp.normal.L; h = wp.normal.B - wp.normal.T;
      }
      if (w <= 0 || h <= 0 || w > 12000 || h > 12000) return "bad-size";
      Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
      Graphics g = Graphics.FromImage(bmp);
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hwnd, hdc, 2); // PW_RENDERFULLCONTENT
      g.ReleaseHdc(hdc); g.Dispose();
      if (!ok) { bmp.Dispose(); return "printwindow-failed"; }
      // 黑帧自检：网格采样 ≤441 点，主导色占比 ≥97% 视为不可用内容
      // （后台 Chromium 窗口停渲染出大面积纯黑+边角残影，100% 同色判定拦不住）
      int[] cc = new int[441]; int[] cf = new int[441];
      int kinds = 0; int total = 0;
      for (int y = 0; y < h; y += Math.Max(1, h / 20)) {
        for (int x = 0; x < w; x += Math.Max(1, w / 20)) {
          int c = bmp.GetPixel(x, y).ToArgb(); total++;
          int k = Array.IndexOf(cc, c, 0, kinds);
          if (k >= 0) cf[k]++; else if (kinds < 441) { cc[kinds] = c; cf[kinds] = 1; kinds++; }
        }
      }
      int dominant = 0;
      for (int i = 0; i < kinds; i++) if (cf[i] > dominant) dominant = cf[i];
      bool blank = total > 0 && dominant * 100 >= total * 97;
      if (blank) { bmp.Dispose(); return "blank-frame"; }
      bmp.Save(outPath, ImageFormat.Png); bmp.Dispose();
      return "ok";
    } catch (Exception e) { return "error: " + e.Message; }
  }
}
`;

let dshCapDllPromise = null;

/** 预编译 DshCap.dll（源码哈希命名，.tmp 原子转正）：Add-Type 每次全量 csc 编译
 *  数百 ms~2s，是截图链路最大延迟源；预编译后 Add-Type -Path 仅加载汇编（几十 ms）。
 *  csc 不可用返回 null（调用方退回内联编译，慢但可用）。 */
async function ensureDshCapDll() {
  if (!dshCapDllPromise) {
    dshCapDllPromise = (async () => {
      const crypto = await import('node:crypto');
      const hash = crypto.createHash('sha1').update(WIN_CAP_CS).digest('hex').slice(0, 10);
      const dir = wgcCacheDir();
      const dll = path.join(dir, `dshcap-${hash}.dll`);
      if (existsSync(dll)) return dll;
      const csc64 = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
      const csc32 = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
      const csc = existsSync(csc64) ? csc64 : (existsSync(csc32) ? csc32 : null);
      if (!csc) return null;
      mkdirSync(dir, { recursive: true });
      const csFile = path.join(dir, `dshcap-${hash}.cs`);
      writeFileSync(csFile, WIN_CAP_CS);
      const dllTmp = dll + '.tmp';
      const args = ['/nologo', '/target:library', `/out:${dllTmp}`, '/r:System.Drawing.dll', csFile];
      let r = await run(csc, args, 60000);
      if (r.code !== 0 || !existsSync(dllTmp)) {
        r = await run(csc, args, 60000);
        if (r.code !== 0 || !existsSync(dllTmp)) {
          try { unlinkSync(dllTmp); } catch {}
          return null;
        }
      }
      try { unlinkSync(dll); } catch {}
      try { renameSync(dllTmp, dll); } catch { return null; }
      return dll;
    })();
    dshCapDllPromise.catch(() => {});
  }
  return dshCapDllPromise;
}

/** PS 脚本头：优先加载预编译 DshCap.dll，失败退回内联 Add-Type 编译。 */
async function dshCapLoaderPs() {
  const dll = await ensureDshCapDll();
  if (dll) return `Add-Type -Path '${dll.replace(/'/g, "''")}'`;
  return `Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'\n${WIN_CAP_CS}\n'@`;
}

async function winListProcesses() {
  const r = await runPS(WIN_PS);
  if (r.code !== 0 || !r.out.trim()) {
    return { ok: false, error: `powershell 失败: ${r.err || r.code}` };
  }
  try {
    const j = JSON.parse(r.out);
    const raw = Array.isArray(j.procs) ? j.procs : j.procs ? [j.procs] : [];
    const processes = raw
      .filter((p) => p && p.pid != null)
      .map((p) => ({
        pid: Number(p.pid),
        name: String(p.name ?? ''),
        memMB: Number(p.memMB ?? 0),
        cpuPct: Number(p.cpuPct ?? 0),
        win: p.win == null || p.win === 0 ? null : Number(p.win),
        title: String(p.title ?? ''),
      }));
    return { ok: true, processes: limitProcs(processes) };
  } catch (e) {
    return { ok: false, error: `解析失败: ${e?.message || e}` };
  }
}

async function winCapture(id, outDir, _retried) {
  const hwnd = String(id).replace(/[^0-9]/g, '');
  if (!hwnd) return { ok: false, error: '缺少窗口句柄' };
  const name = `window-${hwnd}-${Date.now()}.png`;
  const file = path.join(outDir, name);
  const script = `
$ErrorActionPreference = 'Stop'
${await dshCapLoaderPs()}
$r = [DshCap]::Shot([IntPtr]::new(${hwnd}), '${file.replace(/'/g, "''")}')
Write-Output ("RESULT=" + $r)
`;
  const r = await runPS(script, 20000);
  const m2 = /^RESULT=(.*)$/m.exec(r.out);
  const verdict = m2 ? m2[1].trim() : `no-result: ${r.err || r.code}`;
  const STALE = verdict === 'blank-frame' || verdict === 'minimized' || verdict === 'invisible'
    || verdict === 'printwindow-failed' || verdict === 'no-result';
  if (verdict !== 'ok') {
    if (verdict === 'blank-frame' || verdict === 'minimized') {
      // 后台/被遮挡/最小化 → WGC 兜底链（--restore 自动还原最小化，抓完收回）
      const res = await winCaptureBlankFallback(hwnd, outDir);
      return maybeRetrySibling(res, hwnd, outDir, _retried);
    }
    const hints = {
      'minimized': '窗口最小化且无法读取还原尺寸——先还原窗口再试',
      'invisible': '窗口不可见或已关闭',
      'printwindow-failed': '目标窗口拒绝了抓取请求（受保护窗口）',
    };
    const res = { ok: false, error: hints[verdict] || `抓取失败: ${verdict || r.err || r.code}` };
    return maybeRetrySibling(res, hwnd, outDir, _retried);
  }
  if (!existsSync(file) || statSync(file).size < 1000) {
    // 1x1 等占位窗口会产出无意义小图 → 当作黑帧进 WGC 兜底链（tiny 会被明确拒绝）
    try { if (existsSync(file)) unlinkSync(file); } catch (e) { }
    const res = await winCaptureBlankFallback(hwnd, outDir);
    return maybeRetrySibling(res, hwnd, outDir, _retried);
  }
  return { ok: true, file, name, size: statSync(file).size, via: 'printwindow' };
}

/** 陈旧句柄自愈：仅当原 hwnd 已失效或是 <64px 占位窗时，按 pid 找进程当前主窗口重试一次。 */
async function maybeRetrySibling(res, hwnd, outDir, retried) {
  if (res.ok || retried) return res;
  try {
    const script = `
$ErrorActionPreference = 'Stop'
${await dshCapLoaderPs()}
$h0 = [IntPtr]::new(${hwnd})
if (-not [DshCap]::IsWindow($h0)) { Write-Output 'ORIG=dead'; exit }
$r0 = New-Object DshCap+RECT
[void][DshCap]::GetWindowRect($h0, [ref]$r0)
$w0 = $r0.R - $r0.L; $hgt = $r0.B - $r0.T
$vis = [DshCap]::IsWindowVisible($h0)
Write-Output ("ORIG=" + $w0 + "x" + $hgt + " vis=" + $vis)
if (-not $vis -or $w0 -lt 64 -or $hgt -lt 64) {
  $pid2 = [DshCap]::PidOf($h0)
  if ($pid2 -eq 0) { exit }
  Write-Output ("PID=" + $pid2)
  $p = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { Write-Output ("HWND=" + $p.MainWindowHandle) }
}
`;
    const r2 = await runPS(script, 20000);
    const om = /^ORIG=(\d+)x(\d+) vis=(\w+)$/m.exec(r2.out);
    const hm = /^HWND=(\d+)$/m.exec(r2.out);
    if (!om) return res; // 句柄已完全失效且拿不到 pid，维持原错误
    const w0 = +om[1], hgt = +om[2], vis = om[3] === 'True';
    if (vis && w0 >= 64 && hgt >= 64) return res; // 原窗口是真实窗口，失败就是失败，不偷换
    if (!hm) return res;
    const h2 = hm[1];
    if (h2 === hwnd || h2 === '0') return res;
    const again = await winCapture(h2, outDir, true);
    if (again.ok) return again;
  } catch (e) { }
  return res;
}

/** PrintWindow 空图/黑帧 → WGC 兜底 + 明确报错（winCapture 复用）。 */
async function winCaptureBlankFallback(hwnd, outDir) {
  // 后台/被遮挡/最小化：PrintWindow 失败 → WGC 兜底；--restore 先还原最小化再抓，
  // 抓完由 exe 自动恢复最小化（不抢焦点）
  const wgc = await wgcFallback(hwnd, outDir);
  if (wgc.ok) return wgc;
  if (wgc.error === 'minimized') {
    return { ok: false, error: '窗口最小化且无法读取还原尺寸——先还原窗口再试' };
  }
  if (wgc.error === 'tiny') {
    return { ok: false, error: '该窗口没有实际画面（尺寸过小的占位窗口，通常是托盘/后台驻留程序的隐藏窗口）——无法截取' };
  }
  return {
    ok: false,
    error: wgc.error
      ? `窗口被完全遮挡或最小化（后台捕获也未取到画面：${wgc.error}）——把窗口切到前台再试`
      : '窗口被完全遮挡或最小化，应用已暂停渲染（Chrome/VSCode/微信等 Chromium 系最明显）——把窗口切到前台再试',
  };
}

// ---------------- win32 WGC（后台窗口捕获，Win11 22000+） ----------------

const WGC_CS_SRC = `using System;
using System.Runtime.InteropServices;
using System.Threading;
using Windows.Foundation;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.UI;

public static class WgcCap {
  [DllImport("d3d11.dll", SetLastError = false)]
  static extern int D3D11CreateDevice(IntPtr adapter, uint driverType, IntPtr software, uint flags, IntPtr featureLevels, uint numLevels, uint sdkVersion, out IntPtr device, out IntPtr context, out IntPtr featureLevel);
  [DllImport("d3d11.dll", SetLastError = false)]
  static extern uint CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

  public static int Main(string[] args) {
    try { return Run(args); } catch (Exception e) {
      string msg; try { msg = e.GetType().FullName + ": " + e.Message; } catch (Exception) { msg = "unprintable"; }
      Console.WriteLine("fail top " + msg); return 1;
    }
  }
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  // SW_RESTORE=9 不抢焦点，仅解除最小化；SW_MINIMIZE=6 恢复原状态用
  static int Run(string[] args) {
    bool restore = false;
    for (int i = 3; i < args.Length; i++) { if (args[i] == "--restore") restore = true; }
    if (args.Length < 3) { Console.WriteLine("fail bad-args"); return 1; }
    long hwnd; if (!long.TryParse(args[0], out hwnd) || hwnd == 0) { Console.WriteLine("fail bad-hwnd"); return 1; }
    string outPath = args[1];
    int waitMs; int.TryParse(args[2], out waitMs); if (waitMs <= 0) waitMs = 3000;
    IntPtr h = (IntPtr)hwnd;
    bool wasMin = false;
    if (restore && IsIconic(h)) {
      ShowWindow(h, 9);          // SW_RESTORE：解除最小化（不抢焦点）
      wasMin = true;
      Thread.Sleep(900);         // 等 DWM 合成出表面
    }
    try {
      return Capture(hwnd, outPath, waitMs);
    } finally {
      if (wasMin) ShowWindow(h, 6);  // 抓完恢复最小化
    }
  }
  static int Capture(long hwnd, string outPath, int waitMs) {
    WindowId wid = new WindowId(); wid.Value = (ulong)hwnd;
    GraphicsCaptureItem item = GraphicsCaptureItem.TryCreateFromWindowId(wid);
    if (item == null) { Console.WriteLine("fail no-item"); return 1; }
    SizeInt32 size = item.Size;
    if (size.Width <= 0 || size.Height <= 0) { Console.WriteLine("fail minimized"); return 1; }
    if (size.Width < 64 || size.Height < 64) { Console.WriteLine("fail tiny"); return 1; }
    IntPtr d3d, ctx, fl;
    int hr = D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out d3d, out ctx, out fl);
    if (hr != 0) hr = D3D11CreateDevice(IntPtr.Zero, 2, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out d3d, out ctx, out fl);
    if (hr != 0) { Console.WriteLine("fail d3d " + hr); return 1; }
    IntPtr dxgiDev = IntPtr.Zero;
    Guid g = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    Marshal.QueryInterface(d3d, ref g, out dxgiDev);
    IntPtr insp = IntPtr.Zero;
    uint hr2 = CreateDirect3D11DeviceFromDXGIDevice(dxgiDev, out insp);
    if (hr2 != 0) { Console.WriteLine("fail device " + hr2); return 1; }
    var device = (IDirect3DDevice)Marshal.GetObjectForIUnknown(insp);
    var pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
    var session = pool.CreateCaptureSession(item);
    try { session.IsCursorCaptureEnabled = false; } catch (Exception) { }
    try { session.IsBorderRequired = false; } catch (Exception) { }
    session.StartCapture();
    int deadline = Environment.TickCount + waitMs;
    Direct3D11CaptureFrame frame = null;
    while (Environment.TickCount < deadline) {
      frame = pool.TryGetNextFrame();
      if (frame != null && frame.Surface != null) break;
      if (frame != null) frame.Dispose();
      frame = null; Thread.Sleep(30);
    }
    if (frame == null) { Console.WriteLine("fail no-frame"); return 1; }
    var copyOp = SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
    while (copyOp.Status != AsyncStatus.Completed) {
      if (copyOp.Status == AsyncStatus.Error) { Console.WriteLine("fail copy"); return 1; }
      Thread.Sleep(10);
    }
    SoftwareBitmap swb = copyOp.GetResults();
    int w = swb.PixelWidth, h = swb.PixelHeight;
    var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream();
    var encOp = Windows.Graphics.Imaging.BitmapEncoder.CreateAsync(Windows.Graphics.Imaging.BitmapEncoder.PngEncoderId, stream);
    while (encOp.Status != AsyncStatus.Completed) {
      if (encOp.Status == AsyncStatus.Error) { Console.WriteLine("fail encoder"); return 1; }
      Thread.Sleep(10);
    }
    var encoder = encOp.GetResults();
    encoder.SetSoftwareBitmap(swb);
    var flushOp = encoder.FlushAsync();
    while (flushOp.Status != AsyncStatus.Completed) {
      if (flushOp.Status == AsyncStatus.Error) { Console.WriteLine("fail encode-flush"); return 1; }
      Thread.Sleep(10);
    }
    swb.Dispose(); frame.Dispose();
    try { session.Dispose(); } catch (Exception) { }
    try { pool.Dispose(); } catch (Exception) { }
    ulong total = stream.Size;
    var reader = new Windows.Storage.Streams.DataReader(stream.GetInputStreamAt(0));
    var loadOp = reader.LoadAsync((uint)total);
    while (loadOp.Status != AsyncStatus.Completed) {
      if (loadOp.Status == AsyncStatus.Error) { Console.WriteLine("fail load-png"); return 1; }
      Thread.Sleep(10);
    }
    byte[] png = new byte[total];
    reader.ReadBytes(png);
    System.IO.File.WriteAllBytes(outPath, png);
    Console.WriteLine("ok " + w + "x" + h);
    return 0;
  }
}`;

let wgcExePromise = null;

/** WGC 编译缓存目录：放 $DSH_HOME（用户私有）而非共享 TEMP——
 *  TEMP 里的 exe 可被同机其他用户预置/篡改后被执行。 */
function wgcCacheDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'wgc-cache');
}

/** 上次编译失败时刻：坏工具链（csc 缺失/winmd 损坏）下编译最长 ~2×60s，而
 *  hostmon 按 30s 桶重导入会重置进程内 promise 缓存——不加冷却记忆的话，
 *  host-status 关键路径每桶都可能同步重编两轮（看板请求挂死 ~2min）。
 *  失败后 10min 内直接判不可用（第二轮审查 #921）。 */
let wgcFailAt = 0;
const WGC_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

/** 编译并缓存 wgc-cap.exe（源码哈希命名，进程内只编一次）。失败返回 null（走旧提示）。
 *  产物先写 .tmp 再原子改名——并发/残留的半成品不会被当作可用 exe。 */
async function ensureWgcExe() {
  if (wgcFailAt && Date.now() - wgcFailAt < WGC_FAIL_COOLDOWN_MS) return null;
  if (!wgcExePromise) {
    wgcExePromise = (async () => {
      const crypto = await import('node:crypto');
      const hash = crypto.createHash('sha1').update(WGC_CS_SRC).digest('hex').slice(0, 10);
      const dir = wgcCacheDir();
      const exe = path.join(dir, `wgc-cap-${hash}.exe`);
      if (existsSync(exe)) return exe;
      const csc64 = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
      const csc32 = 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe';
      const csc = existsSync(csc64) ? csc64 : (existsSync(csc32) ? csc32 : null);
      if (!csc) return null;
      const facadeRoot = 'C:\\Windows\\Microsoft.NET\\assembly\\GAC_MSIL\\System.Runtime';
      let facade = null;
      try {
        for (const sub of readdirSync(facadeRoot)) {
          const cand = path.join(facadeRoot, sub, 'System.Runtime.dll');
          if (existsSync(cand)) { facade = cand; break; }
        }
      } catch (e) { }
      if (!facade) return null;
      const md = (n) => `C:\\Windows\\System32\\WinMetadata\\${n}`;
      mkdirSync(dir, { recursive: true });
      const csFile = path.join(dir, `wgc-cap-${hash}.cs`);
      writeFileSync(csFile, WGC_CS_SRC);
      const exeTmp = exe + '.tmp';
      const commonArgs = [
        '/nologo', '/target:exe', '/platform:anycpu', `/out:${exeTmp}`,
        '/r:' + md('Windows.Foundation.winmd'),
        '/r:' + md('Windows.Graphics.winmd'),
        '/r:' + md('Windows.UI.winmd'),
        '/r:' + md('Windows.Storage.winmd'),
        `/r:${facade}`, '/unsafe', csFile,
      ];
      let r = await run(csc, commonArgs, 60000);
      if (r.code !== 0 || !existsSync(exeTmp)) {
        // 偶发的并发/句柄问题重试一次
        r = await run(csc, commonArgs, 60000);
        if (r.code !== 0 || !existsSync(exeTmp)) {
          try { unlinkSync(exeTmp); } catch {}
          return null; // 失败不落可用产物（不留半成品被误用）
        }
      }
      try { unlinkSync(exe); } catch {}
      try { renameSync(exeTmp, exe); } catch { return null; }
      return exe;
    })();
    // 失败（含返回 null 的各失败点）记时刻：冷却期内不再徒劳重编
    wgcExePromise.then(
      (v) => { if (!v) wgcFailAt = Date.now(); },
      () => { wgcFailAt = Date.now(); },
    );
    wgcExePromise.catch(() => { });
  }
  return wgcExePromise;
}

async function wgcFallback(hwnd, outDir) {
  let exe;
  try { exe = await ensureWgcExe(); } catch (e) { exe = null; }
  if (!exe) return { ok: false, error: '', wgcUnavailable: true };
  const name = `window-${hwnd}-wgc-${Date.now()}.png`;
  const file = path.join(outDir, name);
  const r = await run(exe, [String(hwnd), file, '3000', '--restore'], 25000);
  if (r.code === 0 && existsSync(file)) {
    // 兜底校验：尺寸过小或文件过小 = 没抓到真实画面（1x1 占位窗口等）
    const okM = /^ok (\d+)x(\d+)/m.exec(r.out || '');
    if (okM && (+okM[1] < 64 || +okM[2] < 64)) {
      try { unlinkSync(file); } catch (e) { }
      return { ok: false, error: 'tiny' };
    }
    if (statSync(file).size < 1000) {
      try { unlinkSync(file); } catch (e) { }
      return { ok: false, error: 'tiny' };
    }
    return { ok: true, file, name, size: statSync(file).size, via: 'wgc' };
  }
  const m = /fail ([^\r\n]*)/.exec(r.out || '');
  const reason = m ? m[1].trim() : 'no-frame';
  return { ok: false, error: reason };
}

// ---------------- darwin ----------------

function parsePs(out) {
  const processes = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const m = /^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(t);
    if (!m) continue;
    const full = m[5].trim();
    processes.push({
      pid: Number(m[1]),
      name: path.basename(full) || full,
      memMB: Math.round((Number(m[4]) / 1024) * 10) / 10,
      cpuPct: Math.round(Number(m[2])),
      win: null,
      title: '',
    });
  }
  return processes;
}

async function macListProcesses() {
  const r = await run('ps', ['-axo', 'pid=,pcpu=,pmem=,rss=,comm=']);
  if (r.code !== 0) return { ok: false, error: `ps 失败: ${r.err || r.code}` };
  const processes = parsePs(r.out);
  // 窗口表：System Events（需辅助功能权限；失败则窗口字段留空，列表仍可用）
  const osa = await run('osascript', ['-e',
    'tell application "System Events"\n' +
    'set out to ""\n' +
    'repeat with p in (application processes whose background only is false)\n' +
    'try\n' +
    'set wts to name of windows of p\n' +
    'if (count of wts) > 0 then\n' +
    'set out to out & (unix id of p as string) & "\\u0009" & (name of p as string) & "\\u0009"\n' +
    'repeat with i from 1 to count of wts\n' +
    'set out to out & (i as string) & "\\u0001" & (item i of wts as string) & "\\u0002"\n' +
    'end repeat\n' +
    'set out to out & linefeed\n' +
    'end if\n' +
    'end try\n' +
    'end repeat\n' +
    'return out\n' +
    'end tell'], 10000);
  if (osa.code === 0 && osa.out.trim()) {
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    for (const line of osa.out.split('\n')) {
      const seg = line.split('\t');
      if (seg.length < 3) continue;
      const pid = Number(seg[0]);
      const p = byPid.get(pid);
      if (!p) continue;
      const wins = seg[2].split('\u0002').filter(Boolean);
      if (wins.length > 0) {
        p.win = `${pid}:1`;
        p.title = (wins[0].split('\u0001')[1] || '').trim();
      }
    }
  }
  return { ok: true, processes: limitProcs(processes), windowPerm: osa.code === 0 };
}

async function macCapture(id, outDir) {
  // id = "pid:idx"：System Events 重查矩形 → screencapture -R 区域截屏
  const m = /^(\d+):(\d+)$/.exec(String(id || ''));
  if (!m) return { ok: false, error: '窗口引用非法（期望 pid:idx）' };
  const [, pid, idx] = m;
  const geo = await run('osascript', ['-e',
    `tell application "System Events" to tell (first application process whose unix id is ${pid})\n` +
    `set pos to position of window ${idx}\n` +
    `set sz to size of window ${idx}\n` +
    `return (item 1 of pos as string) & "," & (item 2 of pos as string) & "," & (item 1 of sz as string) & "," & (item 2 of sz as string)\n` +
    'end tell'], 10000);
  if (geo.code !== 0) {
    return { ok: false, error: '无法读取窗口位置（检查辅助功能权限）' };
  }
  const rect = geo.out.trim();
  const name = `window-${pid}-${Date.now()}.png`;
  const file = path.join(outDir, name);
  const cap = await run('screencapture', ['-x', '-R', rect, file], 15000);
  if (cap.code !== 0 || !existsSync(file)) {
    return { ok: false, error: 'screencapture 失败（检查屏幕录制权限）' };
  }
  return { ok: true, file, name, size: statSync(file).size };
}

// ---------------- linux ----------------

async function whichAll(names) {
  const out = {};
  await Promise.all(names.map(async (n) => {
    const r = await run('sh', ['-c', `command -v ${n} 2>/dev/null`], 5000);
    out[n] = r.code === 0 && r.out.trim().length > 0;
  }));
  return out;
}

async function linuxListProcesses() {
  const r = await run('ps', ['-axo', 'pid=,pcpu=,pmem=,rss=,comm=']);
  if (r.code !== 0) return { ok: false, error: `ps 失败: ${r.err || r.code}` };
  const processes = parsePs(r.out);
  const tools = await whichAll(['wmctrl', 'xdotool', 'import', 'scrot']);
  const x11 = Boolean(process.env.DISPLAY) && process.env.XDG_SESSION_TYPE !== 'wayland';
  if (x11 && tools.wmctrl) {
    const w = await run('wmctrl', ['-lp'], 8000);
    if (w.code === 0) {
      const byPid = new Map(processes.map((p) => [p.pid, p]));
      for (const line of w.out.split('\n')) {
        const m = /^(\S+)\s+\S+\s+(\d+)\s+(.*)$/.exec(line.trim());
        if (!m) continue;
        const p = byPid.get(Number(m[2]));
        if (p) {
          p.win = m[1];
          p.title = m[3].trim();
        }
      }
    }
  }
  return { ok: true, processes: limitProcs(processes), windowOk: x11 && tools.wmctrl, captureOk: x11 && tools.import };
}

async function linuxCapture(id, outDir) {
  const wid = String(id || '').trim();
  if (!/^0x[0-9a-fA-F]+$/.test(wid)) return { ok: false, error: '窗口引用非法（期望 X 窗口 id）' };
  const name = `window-${wid}-${Date.now()}.png`;
  const file = path.join(outDir, name);
  const cap = await run('import', ['-window', wid, file], 15000);
  if (cap.code !== 0 || !existsSync(file)) {
    return { ok: false, error: 'import 抓取失败（需要 ImageMagick 与 X11）' };
  }
  return { ok: true, file, name, size: statSync(file).size };
}

// ---------------- 统一出口 ----------------

export async function hostStatus() {
  const p = platform();
  const base = { platform: p, host: hostname(), ts: Date.now() };
  if (p === 'win32') {
    const r = await winListProcesses();
    // wgc/restore：WGC 兜底链可用性（exe 编译缓存命中与否）——端上按能力决定
    // 截图失败的提示文案（「尝试还原窗口重试」只在 restore 可用时展示）
    let wgc = false;
    try { wgc = !!(await ensureWgcExe()); } catch {}
    return {
      ...base,
      capabilities: { processList: true, windowList: true, capture: true, wgc, restore: wgc },
      processes: r.ok ? r.processes : [],
      error: r.ok ? undefined : r.error,
    };
  }
  if (p === 'darwin') {
    const r = await macListProcesses();
    return {
      ...base,
      capabilities: { processList: true, windowList: true, capture: true },
      processes: r.ok ? r.processes : [],
      windowPerm: r.windowPerm,
      error: r.ok ? undefined : r.error,
    };
  }
  // linux
  const r = await linuxListProcesses();
  return {
    ...base,
    capabilities: {
      processList: true,
      windowList: !!(r.windowOk),
      capture: !!(r.captureOk),
    },
    processes: r.ok ? r.processes : [],
    error: r.ok ? undefined : r.error,
  };
}

export async function captureWindow(id, outDir) {
  const p = platform();
  if (p === 'win32') return winCapture(id, outDir);
  if (p === 'darwin') return macCapture(id, outDir);
  return linuxCapture(id, outDir);
}
