# Claude Code Instructions — `RTX5-Main-Orchestration` (`CLAUDE.md`)

> **CRITICAL TOP-PRIORITY RULE — STRICT CI/CD LOCK:**  
> **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

Always read **[`PROJECT_MEMORY.md`](./PROJECT_MEMORY.md)**, **[`ENGINEERING_RULES.md`](./ENGINEERING_RULES.md)**, and **[`AGENTS.md`](./AGENTS.md)** at the start of every session.

---

## 1. Essential Architecture & Boundaries

1. **Read-Only Reference Folders (NEVER TOUCH)**:
   - `d:\RTX5-Orchestration\RTX5-Main-Orchestration\1-Web-Codebase`
   - `d:\RTX5-Orchestration\RTX5-Super Admin`, `RTX5-Broker`, `Rtx5-Desktop-App`
   - `rtx5_guard.dll` (SHA-256: `28b5aa822fdd636f2d1586f74fdc216ea86e6d5924b4ddd44a4430f8d820b13b`)
2. **Active Folders**:
   - `2-TCP-Codebase\`: Pure Encrypted Binary TCP (`RTX\x05` v2) backend, desktop clients, `web-terminal-tcp`, `ui-overrides/{superadmin-ui,admin-ui,manager-ui,terminal-ui}`, and `scripts/`.
   - `3-EXE-Packages-To-Run-And-Share\`: Distributable Windows `.exe` packages, Single-File Setup Installers (`RTX5-Terminal-Setup64.exe`, `RTX5-Broker-Setup64.exe`, `RTX5-SuperAdmin-Setup64.exe`), Linux VPS packages (`linux/`), and `ota-releases/` (`v2.2.6`).
   - `4-TCP-Git-Repos-v1.0.0\`: The 6 private GitHub repositories under `https://github.com/Orrnn-RTX5/` (`Animesh-singha <singhaanimesh216@gmail.com>`).
3. **Tech Stack & Wire Protocol (`RTX\x05` v2)**:
   - **Backend**: Go 1.24 (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"` on Linux; `rtx5_guard.dll` DPAPI/HWID on Windows), 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`), PostgreSQL 16 (pipelined `pgx v5.9.0 SendBatch` + Async WAL), local `127.0.0.1` Redis/NATS + `:8190` (`RTO\x01`/`RTO\x02` 32-socket binary pool).
   - **Frontend**: React 19 + TypeScript/JS + Vite 6 + Zustand (`O(1)` reference checks + `requestAnimationFrame` coalescing), embedded via Go `embed.FS` into `RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`, and `rtx5-web-terminal-server` (`https://tcp-terminal.orrnn.com`).
   - **Encryption & Binary Frames**: `X25519 ECDH` + `HKDF-SHA256` + `AES-256-GCM` (`MaxEncryptedFrameBytes = 32 MB`), `0x21` (48B Tick), `0x22` (72B Candle), `0x38` (128B/132B Order Req), `0x39` (136B/140B Order Resp), `0x3A`/`0x3B` (Private Trade Events), `0x34`–`0x37` (Ed25519 Binary OTA).
4. **Live Production VPS (`185.126.217.108` / `root@animesh`, `/root/Rtx-TCP`)**:
   - `1-SuperAdmin` (`rtx5-superadmin.service`, `:9100`, IC Markets UK FIX 4.4 `6157214`)
   - `2-Broker` (`rtx5-broker.service`, `:4443` / `:8190` / `:8194`, active broker **`yo4x`**, `/opt/rtx5-broker/config/broker.lic`)
   - `3-Web-Terminal` (`rtx5-web-terminal.service`, `:8443` / `:443`, **`https://tcp-terminal.orrnn.com`**)

---

## 2. Build, OTA Auto-Push (`v2.2.6`), & Verification Commands

- **Build All + Sign + Auto-Push OTA over `:9100` Binary TCP**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6"
  ```
- **Fast Sign + Auto-Push OTA over `:9100` Binary TCP**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6" -SkipUIBuild -SkipClientBuild
  ```
- **Mandatory Post-Change Stress & Sub-0.5ms Verification Suite**:
  ```powershell
  cd "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\desktop-clients"
  go run ./cmd/verify_sub05ms_calc_sync
  go run ./cmd/sandbox_flood_crash_stress
  go run ./cmd/verify_ota_and_versions
  ```

---

## 3. CRITICAL DESKTOP `.EXE`, SINGLE-FILE SETUP INSTALLERS (`*-Setup64.exe`), & PACKAGING ANTI-REGRESSION RULES (DO NOT REPEAT)

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
