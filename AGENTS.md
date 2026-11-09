# AI Agent Instructions — `RTX5-Main-Orchestration` (`AGENTS.md`)

> **CRITICAL TOP-PRIORITY RULE — STRICT CI/CD LOCK:**  
> **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

Read **[`PROJECT_MEMORY.md`](./PROJECT_MEMORY.md)** and **[`ENGINEERING_RULES.md`](./ENGINEERING_RULES.md)** before making any changes.

---

## 1. Workspace Architecture & Strict Folder Boundaries

- **`1-Web-Codebase\`**: **100% READ-ONLY** canonical Web reference repositories. **NEVER modify any file in `1-Web-Codebase\`.**
- **`2-TCP-Codebase\`**: **ACTIVE** Pure Binary TCP (`RTX\x05` v2) codebase:
  - `rtx5-tcp-protocol\`: `X25519 ECDH` + `HKDF-SHA256` + `AES-256-GCM` wire protocol (`0x21` 48B ticks, `0x22` 72B candles, `0x38` 128B order req, `0x39` 136B order resp, `0x3A`/`0x3B` trade events, `0x34`–`0x37` Ed25519 OTA, `guard_windows.go` + `guard_linux.go`).
  - `superadmin-tcp-hub\`: Public `:9100` Encrypted Binary TCP Hub (`185.126.217.108:9100`), IC Markets UK FIX 4.4 (`6157214`) tick fanout, 6-Layer HWID/DPAPI/IP license authority, `.srv` dynamic broker directory, and `:9100` OTA upload receiver (`POST /api/tcp-security/ota/upload`).
  - `broker-tcp-access-server\`: Public `:4443` Encrypted Binary TCP Access Server (`185.126.217.108:4443`), `0x38`/`0x39` fast-lane (`127.0.0.1:8190` `RTO\x01` 32-socket pool), and automatic Linux Broker Backend Fleet OTA updater (`backend_ota_updater.go`).
  - `backend-staging\`: Go 1.24 `rtx5-gateway` (256-Shard `RAMMT5Engine` + Binary `.WAL` + PostgreSQL 16 pipelined `pgx v5.9.0 SendBatch`) and local `127.0.0.1` microservices.
  - `desktop-clients\`: 64-bit Windows `.exe` client wrappers (`RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`), Single-File Setup Installer builder (`cmd/rtx5-setup-installer`), icon generator (`cmd/gen-win-icon`), `rtx5-web-terminal-server`, and post-change stress verification tools (`cmd/verify_sub05ms_calc_sync`, `cmd/sandbox_flood_crash_stress`, `cmd/verify_ota_and_versions`).
  - `web-terminal-tcp\`: Separated SSL Binary TCP Web Terminal (`https://tcp-terminal.orrnn.com`, port `:8443` / `:443`).
  - `ui-overrides\{superadmin-ui,admin-ui,manager-ui,terminal-ui}`: Active Pure Binary TCP UI overrides (never edit `ui-staging\*` directly; `05-stage-and-build-uis.ps1` regenerates `ui-staging\*` and outputs `terminal-ui` `dist/` to **both** `RTX5-Terminal64.exe` and `web-terminal-tcp/server/dist`).
- **`3-EXE-Packages-To-Run-And-Share\`**: Distributable Windows `.exe` packages (`1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader`, `4-BROKER-VPS-Backend-Server`), Single-File Windows Setup Installers (`RTX5-Terminal-Setup64.exe`, `RTX5-Broker-Setup64.exe`, `RTX5-SuperAdmin-Setup64.exe`), Linux VPS packages (`linux/{1-SUPERADMIN-Linux-VPS,2-BROKER-Linux-VPS,3-WEB-TERMINAL-Linux-VPS}` + `.deb` installers), and `ota-releases/` (`v2.2.6`).
- **`4-TCP-Git-Repos-v1.0.0\`**: The 6 private GitHub repositories under `https://github.com/Orrnn-RTX5/` (`rtx5-production-superadmin-UI-TCP`, `rtx5-production-superadmin-backend-TCP`, `Broker-Backend-V2-TCP`, `Broker-Manager-UI-TCP`, `Broker-Admin-UI-TCP`, `Broker-Terminal-UI-TCP`), authored by `Animesh-singha <singhaanimesh216@gmail.com>`.
- **NEVER touch `rtx5_guard.dll`** (canonical SHA-256: `28b5aa822fdd636f2d1586f74fdc216ea86e6d5924b4ddd44a4430f8d820b13b`).

---

## 2. Live Production VPS (`185.126.217.108` / `root@animesh`) & Active Broker `yo4x`

- **VPS Host**: `185.126.217.108` (`root@animesh`, Ubuntu 24.04 LTS), organized under **`/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`** (`/opt/rtx5-{superadmin,broker,web-terminal}`).
- **Systemd Services**:
  - `rtx5-superadmin.service` (`:9100`)
  - `rtx5-broker.service` (`:4443` / `:8190` / `:8194`, active licensed broker **`yo4x`**, license at `/opt/rtx5-broker/config/broker.lic`)
  - `rtx5-web-terminal.service` (`:8443` / `:443`, serving **`https://tcp-terminal.orrnn.com`** with Let's Encrypt TLS)

---

## 3. Single-Command Build, Sign & `:9100` Binary TCP OTA Auto-Push (`v2.2.6`)

- **Full Build (4 UIs + 4 Windows `.exe`s + Stripped Linux Binaries) + Ed25519 Sign + `:9100` Auto-Push**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6"
  ```
- **Fast Sign + `:9100` Auto-Push (if UIs and binaries are already built)**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6" -SkipUIBuild -SkipClientBuild
  ```
- **`:9100` Frame Size Invariant**: `MaxEncryptedFrameBytes = 32 MB` (`< 24 MB` raw per RPC). Keep Linux binaries stripped (`-ldflags="-s -w"`) so `broker-linux-backend.zip` (`~14.1 MB`) and `web-terminal-linux.zip` (`~6.8 MB`) push cleanly over `:9100` Binary TCP.

---

## 4. Mandatory Post-Change Stress & Latency Verification

After **every** code change, run:
```powershell
cd "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\desktop-clients"
go run ./cmd/verify_sub05ms_calc_sync
go run ./cmd/sandbox_flood_crash_stress
go run ./cmd/verify_ota_and_versions
```
Ensure `< 0.5 ms` (`18–350 µs`) RAM + `.WAL` execution, exact MT5 margin/equity/PnL math, 1,000+ concurrent order flood survival, malformed frame fuzzing resilience, `0` `40P01` deadlocks, and 100% OTA signature/version parity.

---

## 5. CRITICAL DESKTOP `.EXE`, SINGLE-FILE SETUP INSTALLERS (`*-Setup64.exe`), & PACKAGING ANTI-REGRESSION RULES (DO NOT REPEAT)

1. **Canonical Desktop `.EXE` Build Directory is Strictly `2-TCP-Codebase\build\clients\`**:
   - `06-build-desktop-clients.ps1` compiles all 4 Windows 64-bit apps (`RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`) into **`2-TCP-Codebase\build\clients\`** using `-ldflags="-s -w -H=windowsgui"`.
   - **NEVER** use, create, or copy from `build\desktop-clients\` (an obsolete legacy folder that held old non-`windowsgui` console builds that opened a black `cmd.exe` window and external Microsoft Edge tabs).
2. **Native Win32 WebView2 Window Only (`clientcore/window_windows.go`)**:
   - All 4 Windows `.exe` apps launch inside an in-process **Native Win32 WebView2 Window** (`runNativeWin32Window` via `github.com/jchv/go-webview2`) with `-H=windowsgui` — **ZERO** black console windows, **ZERO** external Edge/Chrome browser tabs, and **ZERO** browser sync/extension popups.
3. **Single-File Windows Setup Installers (`*-Setup64.exe`)**:
   - Located in `3-EXE-Packages-To-Run-And-Share\RTX5-Terminal-Setup64.exe`, `RTX5-Broker-Setup64.exe`, and `RTX5-SuperAdmin-Setup64.exe` (and inside each role subfolder).
   - Built from `2-TCP-Codebase\desktop-clients\cmd\rtx5-setup-installer` (`rtx5-setup-base.exe` compiled with `-ldflags="-s -w -H=windowsgui"`) + appended ZIP payload + 24-byte `RTX5SET1` trailer.
   - Installs into `%LOCALAPPDATA%\Programs\RTX5\<AppFolder>`, creates Desktop & Start Menu `.lnk` shortcuts with `rtx5.ico`, registers in `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RTX5-*`, and launches the app.
4. **Windows 11 Taskbar & Explorer Icon (`rsrc_windows_amd64.syso`)**:
   - Every `cmd/rtx5-*-client/` and `cmd/rtx5-setup-installer/` directory MUST contain `rsrc_windows_amd64.syso` (`RT_GROUP_ICON` Resource ID `1` generated by `cmd/gen-win-icon`) AND `window_windows.go` must call `SetCurrentProcessExplicitAppUserModelID`, `WM_SETICON`, and `SetClassLongPtrW` (`GCLP_HICON` / `GCLP_HICONSM`) so Windows Explorer and the Windows 11 Taskbar always display the RTX5 icon instead of a generic blue square icon.
5. **GitHub Actions CI/CD Rule for UI Repos**:
   - Always use `npm install --no-audit --no-fund --legacy-peer-deps` and `npm run build` (never `npm ci`) in `.github/workflows/ota-auto-push.yml` for the 4 UI repos.
6. **Sub-0.4ms Order Execution Latency Rule**:
   - Never add synthetic `+ 0.25 ms` / `+ 0.35 ms` padding to `wireExecMs` in `binaryTcpOrderClient.ts` or include pre-send JS allocation time before `sentAtPerfMs` in `api.ts`.
7. **Keep Package Folders Clean of `.running_old` / `.old` / Obsolete Binaries**:
   - Never leave `*.running_old`, `*.old`, `rtx5-fix-receiver`, or `rtx5-webterminal` inside `3-EXE-Packages-To-Run-And-Share\`.
   - For `web-terminal-linux.zip`, the Linux Web Terminal source directory is strictly `2-TCP-Codebase\web-terminal-tcp\server` (never `desktop-clients\cmd\rtx5-web-terminal-server`).

## Merging pull requests

Whenever a pull request is merged into `main`, delete its branch at once:
`gh pr merge <number> --merge --delete-branch`. The repository has `delete_branch_on_merge`
enabled, so no stale merged branches remain (RELEASE_RULES.md, section 3).
