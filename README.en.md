# dsh-relay-plugin

[简体中文](README.md) | **English**

> DSH phone-channel bridge plugin: installs into a dsh profile and mounts/unmounts together with dsh, forwarding relay traffic (HTTP/WS) to the local dsh web — so your phone can safely reach your home dsh even off the LAN.

> The npm package name matches the repository name; in the profile's `insert` patch, set `name:` to `dsh-relay-plugin` (the `id` is arbitrary — examples keep `mobile-bridge`).

```
Phone app ──cloud mode──▶ relay (public VPS) ──WS dsh-relay-v1──▶ this plugin (inside the dsh process) ──▶ http://127.0.0.1:3080 (local dsh web)
   └──────LAN mode (relay not involved): same Wi-Fi straight to dsh web; scan the dshlan:// QR to create the environment
```

| Repository | Role |
|---|---|
| This repo **dsh-relay-plugin** | Bridge plugin (Node.js cordis bundle, runs inside the dsh process) |
| [dsh-relay-service](https://github.com/cicbyte/dsh-relay-service) | Relay server (Rust, public VPS) + protocol design and end-to-end tests |
| [dsh-relay-mobile](https://github.com/cicbyte/dsh-relay-mobile) | Phone app (Flutter, "cloud relay / LAN direct" modes) |

## Features

- **Auto-mounts with dsh** — cordis bundle plugin; `patchReload: live` hot-mounts without restarts, no more hand-run scripts;
- **Visual configuration in Settings** — dsh Settings → "Phone Channel" (手机通道) edits the relay URL / pairing code / local dsh URL; saving takes effect immediately (the bridge reconnects with the new config); cleared fields fall back to file/env defaults;
- **Dual-channel QR onboarding** — cloud: the bridge uses its device token to proxy-issue a one-time pairing code and renders a `dshrelay://` QR (no admin console needed — family members just scan); LAN: a `dshlan://` direct-connect QR (security code = web launch token);
- **Resumable reconnect (protocol v3)** — a relay disconnect no longer tears down local tunnels; outbound frames queue up and are replayed from the resume point after reconnect; simultaneous small frames are coalesced into `batch` envelopes with zero added latency;
- **Self-healing reconnect** — backoff resets only on `welcome`; credential rejections and rate limiting back off ≥30s and honor the server's `retryAfterSecs`, preventing reconnect storms;
- **Safe forwarding** — only `cookie` / `content-type` / `accept` / `authorization` headers are forwarded, Host pinned to loopback to pass dsh's trust barrier; a pairing code under 6 chars keeps the bridge from starting (installing without pairing is safe).

## Contents

- [Install into a profile (activation = two steps)](#install-into-a-profile-activation--two-steps)
- [Connect your phone](#connect-your-phone)
- [Configuration (highest priority first)](#configuration-highest-priority-first)
- [Pairing & device credentials (protocol v2)](#pairing--device-credentials-protocol-v2)
- [Uninstall / disable](#uninstall--disable)
- [Standalone run (without dsh)](#standalone-run-without-dsh)
- [Testing](#testing)
- [Implementation notes](#implementation-notes)

## Install into a profile (activation = two steps)

```powershell
# 0) First confirm which profile dsh actually runs! (wrong profile = nobody watches it, looks like "hot reload broke")
#    Get-CimInstance Win32_Process -Filter "Name='node.exe'" — look at --profile <name>
#    DeepSeek Harness Desktop = tauri; dsh web = web
# 1) Install the dependency (⚠️ cross-drive pitfall below)
dsh plugin --profile <name> add link:<same-drive junction or plugin directory>

# 2) Activate: add an insert to that profile's cordis.patch.yml (same mechanism as the amber theme)
#    C:\Users\<you>\.dsh\profiles\<name>\cordis.patch.yml
# - insert:
#     - id: mobile-bridge
#       name: dsh-relay-plugin
```

- After editing that profile's `cordis.patch.yml`, `patchReload: live` hot-mounts immediately (seconds after the insert, the plugin applies and the bridge connects to the relay);
- ⚠️ **Cross-drive pitfall**: pnpm normalizes `link:` / `file:` targets to relative paths; across drives (sources on D:, profile on C:) it builds a broken junction. Fix: create a same-drive junction first, then link:

```powershell
mklink /J C:\Users\<you>\.dsh\plugins\dsh-relay-plugin D:\code\cicbyte\dsh-mobile\dsh-relay\dsh-relay-plugin
# then: dsh plugin --profile <name> add link:C:/Users/<you>/.dsh/plugins/dsh-relay-plugin
```

## Connect your phone

| Mode | Steps | QR protocol |
|---|---|---|
| Cloud relay | After the bridge is paired, the settings page's "phone connect QR" → scan with the phone app (cloud relay mode); the forwarding environment is created and paired automatically | `dshrelay://<relay-host>/?pair=<one-time code>&room=<room>&name=<name>` |
| LAN direct | Settings page "LAN direct" card → generate QR → scan with the phone app to reach the local dsh web directly (no relay) | `dshlan://<LAN IP>:<dshPort>/?code=<launch token>&name=<PC name>` |

Both entries are served by this plugin's dsh web routes: `GET /mobile-bridge/status` (status, polled by the settings page every 5s: relay connection / phone online / active tunnels / connected-at), `POST /mobile-bridge/invite` (proxy-issued pairing code), `GET /mobile-bridge/lan-qr` (LAN QR).

## Configuration (highest priority first)

1. **Settings → "Phone Channel"** (user layer of the Host settings document `mobile-bridge` namespace, hot-effective in real time; cleared fields fall back to the base layer);
2. **loader entry `config` / environment variables / `$DSH_HOME/mobile-bridge.json`** (these also form the base layer of the settings namespace):

```json
{
  "relayUrl": "wss://your-vps:8787",
  "code": "<long random pairing code>",
  "dshUrl": "http://127.0.0.1:3080"
}
```

All fields (`resolveConfig`):

| Field | Environment variable | Default | Description |
|---|---|---|---|
| `relayUrl` | `RELAY_URL` | `ws://127.0.0.1:8787` | relay ws(s) address |
| `code` | `RELAY_CODE` | (empty) | Shared pairing code (code mode); under 6 chars the bridge won't start |
| `dshUrl` | `DSH_URL` | `http://127.0.0.1:3080` | Local dsh web address |
| `pairingCode` | `RELAY_PAIRING_CODE` | (empty) | One-time host pairing code (first pairing only; burned on success) |
| `deviceId` / `token` | `RELAY_DEVICE_ID` / `RELAY_DEVICE_TOKEN` | auto-persisted after pairing | Device credentials (hello v2 token reconnect) |
| `name` | `RELAY_DEVICE_NAME` | `bridge-<hostname>` | Device name |
| `adminUrl` | `RELAY_ADMIN_URL` | derived from `relayUrl` (`:8787`→`:8788`) | Admin-plane address (for proxy-issuing pairing codes) |

## Pairing & device credentials (protocol v2)

1. **First pairing**: generate a role=host one-time pairing code in the admin console / environment view → enter it in the settings page or `RELAY_PAIRING_CODE`;
2. On successful handshake (`welcome`) the server returns `device{id, token}` → **auto-persisted** to `$DSH_HOME/mobile-bridge.json`; from then on the bridge reconnects with the token (the one-time code is burned);
3. **Revocation**: after `bye revoked` the bridge self-heals slowly (≥30s backoff); re-generate a pairing code or rotate the token in the admin console;
4. **Proxy-issued pairing codes**: once paired, the bridge can use its own device token to sign role=client pairing codes via the admin plane (`POST /api/invite`) — that's what powers the settings-page QR, no admin login needed.

> In device-credential mode the hello **does not carry `code`** (the server treats the code hash as the room claim; sending a room-id as code misreports room-mismatch). `code` is only for the legacy shared-code mode (`AUTH_MODE=code`).

## Uninstall / disable

**Disable (recommended, hot-effective)**: add an id-targeted override to the profile's `cordis.patch.yml` (`disabled` supports `!!js` expressions):

```yaml
# Kill switch: true = tear the bridge down (effective in seconds); delete this block or set false to restore
- id: mobile-bridge
  disabled: true
```

On effect the bridge is torn down (connections and tunnels closed) and the status routes plus the "Phone Channel" panel go offline with it (after a page refresh). Patch syntax: `insert` is push semantics; other blocks target an entry by `id` and override its fields (`name` optional — if present it must match, otherwise the block is skipped).

**Full uninstall**:

```powershell
dsh plugin --profile <name> remove dsh-relay-plugin
```

Or delete the insert block from the profile's `cordis.patch.yml` (live reload tears it down).

> ⚠️ Packages that ship `dsh.client` without `dsh.bundle` get a shim entry mounted by dshmarket (id like `mkt-client-<package>`); if such a package is uninstalled but leftover shims in the running instance each start a bridge and fight over the relay, tear them down the same way with `disabled: true` by id — they're gone after restart.

## Standalone run (without dsh)

```powershell
# First time: generate a host pairing code in the admin console
$env:RELAY_URL='wss://your-vps:8787'; $env:RELAY_PAIRING_CODE='XXXX-XXXX'; node tools/standalone.mjs
# Once paired (credentials persisted), just run
node tools/standalone.mjs
# Optional: BRIDGE_DEBUG=1 for debug logs; BRIDGE_CONFIG=<path> for a different config file
```

`node lib/bridge.js` (only understands the `RELAY_CODE` shared code) also works; `tools/standalone.mjs` is recommended (SIGTERM handling + startup config dump).

## Testing

```powershell
node test\apply-smoke.mjs   # plugin shape + settings registration + hot reload + disposer teardown
node test\lan-qr.mjs        # dshlan:// QR logic

# End-to-end (with the relay up; tools live in the dsh-relay-service repo)
node ..\dsh-relay-service\test\test-client.mjs                              # HTTP channel
node ..\dsh-relay-service\test\test-mux.mjs ws://<relay> <code> <sessionId> # WS tunnel
```

## Implementation notes

| File | Responsibility |
|---|---|
| `lib/bridge.js` | The `MobileBridge` core: frames aligned with the relay's `dsh-relay-v1` (hello/welcome, http-req/res, ws-open/frame/close (`__open__` sentinel, rid-idempotent reopen), ping/pong, batch/resume, tunnel teardown on peer offline) + `resolveConfig` three-level config + `update(config)` hot restart + standalone entry |
| `lib/impl.js` | Host half: `apply(ctx, config)` — settings namespace registration + `settings/updated` hot reload + `/mobile-bridge/*` routes (status / invite / lan-qr) |
| `lib/client.js` | Browser half: the "Phone Channel" settings page (`__ModuleLoader__` factory + `settings.section` slot + `settingsScope.bind` reads/writes) |
| `lib/index.js` | Thin re-export shell (entry compatibility) |
| `tools/standalone.mjs` | Standalone run entry (no dsh plugin host) |

**Protocol evolution**: v1 shared pairing code + exponential-backoff reconnect → v2 device identity (token-first / one-time pairing code for first pairing / persisted credentials / proxy-issued pairing codes) → v3 resumable reconnect (`resumeFrom` checkpoint + outbound queue + `batch` coalescing) + long backoff on rate limiting.

**Hot-patching code in a running instance** (the loader's import memoization hits by URL, and failed resolution poisons the module graph):

- Host-half forwarding logic: `impl.js` dynamically imports `bridge.js` with a `?t=` query to bust the cache — after editing `lib/bridge.js`, remove/re-insert the entry in the patch layer and it takes effect, no repackaging;
- `lib/client.js`: no entry re-mount needed (client-hmr's `rebuilt()` re-hashes; effective on next page load);
- The `webServer` handler is **node-style `(req, res)`** (not a fetch Response);
- After a cold start all caches are cleared; the entry name can just be `dsh-relay-plugin`.

## License

[MIT](LICENSE) © cicbyte
