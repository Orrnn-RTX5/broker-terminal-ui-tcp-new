# PROJECT_MEMORY.md â€” `Broker-Terminal-UI-TCP` (`v2.2.4`)

> **ðŸ”’ STRICT CI/CD LOCK RULE**: **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

This document serves as the authoritative architectural memory for developers and autonomous AI coding agents working inside `Broker-Terminal-UI-TCP`.

---

## 1. Dual-Runtime Architecture: One Codebase Powers BOTH Desktop `.exe` & Linux Web Terminal

`Broker-Terminal-UI-TCP` is unique in the 6-repository `Orrnn-RTX5` Pure Binary TCP stack because **this single repository builds and powers TWO production trader targets**:

1. **Windows 64-Bit Native Desktop Trader (`RTX5-Terminal64.exe`)**:
   - Built via `npm run build:desktop` (`tsc -b && vite build --mode desktop`).
   - Staged by `05-stage-and-build-uis.ps1` into `2-TCP-Codebase/desktop-clients/cmd/rtx5-terminal-client/dist` (embedded into `RTX5-Terminal64.exe` via `//go:embed all:dist`) and packaged into `terminal-ui-dist.zip` for `:9100` Binary TCP OTA hot-updates.
2. **Linux Pure Binary TCP Web Terminal (`rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com`)**:
   - Uses the **exact same** `dist/` output staged into `2-TCP-Codebase/web-terminal-tcp/server/dist` (and `web-terminal-server/dist` in this repo).
   - Compiled with `web-terminal-server/` (`main.go`, `binary_order_bridge.go`, `binary_stream.go`, `tcp_toolbar.js`) into `rtx5-web-terminal-server` (`web-terminal-linux.zip` / `rtx5-web-terminal_2.2.4_amd64.deb` deployed at `/root/Rtx-TCP/3-Web-Terminal`).

---

## 2. The 6-Repository `Orrnn-RTX5` Pure Binary TCP Ecosystem

1. **`Super-Admin-Commands-TCP`**:
   - Hosts `rtx5-superadmin-tcp` (`:9100`), the global `.srv` Broker Discovery Registry, Ed25519 License Generator (`broker.lic`), Binary OTA Distribution Hub (`0x34â€“0x37`), and `RTX5-SuperAdmin64.exe`.
2. **`Broker-Commands-TCP`**:
   - Hosts the Broker VPS backend (`rtx5-server-tcp` `:4443`, `rtx5-gateway` `:8080` & `RTO\x01` `:8190`, 256-Shard `RAMMT5Engine` + Binary `.WAL`, `rtx5-market-feed`, PostgreSQL 16 `pgx v5.9.0 SendBatch` persistence) and the Go native launcher suite (`desktop-clients/`).
3. **`Broker-Admin-UI-TCP`**:
   - React 19 + Vite Broker Administrator Control Plane UI embedded into `RTX5-Admin64.exe` (`admin-ui-dist.zip`).
4. **`Broker-Manager-UI-TCP`**:
   - React 19 + Vite Dealing Desk Manager UI embedded into `RTX5-Manager64.exe` (`manager-ui-dist.zip`).
5. **`Broker-Terminal-UI-TCP` (THIS REPO)**:
   - Dual-target Trader Terminal UI (`RTX5-Terminal64.exe` + `terminal-ui-dist.zip` AND `rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com` + `web-terminal-linux.zip`).
6. **`Broker-CRM-TCP`**:
   - Optional Broker Trader Portal & CRM (`rtx5-crm-tcp`).

---

## 3. Full Tech Stack & Packaging Architecture (`.exe` & `.deb`)

### Backend Stack
- **Go 1.24**: Static Linux binaries (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"`) for VPS deployment; Windows 64-bit native desktop clients linked with `rtx5_guard.dll` (Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation).
- **Execution & Persistence**: 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`) delivering `< 0.5 ms` (`18â€“350 Âµs`) order execution, backed by PostgreSQL 16 (`pgx v5.9.0 SendBatch` + Async WAL + idempotent `broker-schema-compat.sql`) and local-only (`127.0.0.1`) Redis/NATS buses.

### Frontend Stack (`Broker-Terminal-UI-TCP`)
- **React 19 + TypeScript 5.9 + Vite 7 + Tailwind CSS v4 + Lightweight Charts 5.1 + Zustand 5** (`O(1)` reference checks + `requestAnimationFrame` coalescing).
- **Binary Order Fast-Lane (`src/services/binaryTcpOrderClient.ts`)**:
  - Persistent Binary WebSocket on `/__rtx5_binary_order_ws` (plus HTTP octet-stream fallback on `/__rtx5_binary_order`).
  - Pre-binds JWT once via `reqId = 0`, then transmits fixed **132-byte** binary order frames (`4-byte reqId` + `128-byte BinaryOrderFastReq`) and receives **140-byte** binary fill responses (`4-byte reqId` + `136-byte BinaryOrderFastResp`).
- **Binary Market & Trade Event Stream (`src/services/binaryTcpMarketStream.ts`)**:
  - Streams `0x21` (48-byte ticks), `0x22` (64-byte stream / 72-byte wire candles), and `0x3A` (private account/position/order/deal push events) from `GET /__rtx5_binary_stream`.
  - Binds authenticated account subscriptions via `POST /__rtx5_binary_account_sub` (`0x3B`).
  - Loads historical OHLCV candles in raw binary format via `GET /api/v2/binary-candles/{symbol}` (`fetchBinaryCandles()`).

### Why `.exe` and `.deb` Packages Are Built This Way
- **Browser Isolation**: Launching `RTX5-Terminal64.exe` with `--disable-extensions` and an isolated `%LOCALAPPDATA%\RTX5-Desktop-Profiles\terminal` directory prevents browser extensions from interfering with WebGL/Canvas charts or order packets.
- **Zero Public Web Attack Surface**: No public REST/WS endpoints are exposed on the broker backend; all traffic uses `:4443` and `:9100` encrypted Binary TCP (or local `127.0.0.1:8190` `RTO\x01` when `rtx5-web-terminal-server` runs on the Broker VPS).
- **Hardware Attestation**: `rtx5_guard.dll` enforces DPAPI token encryption and HWID session locking on Windows.
- **Portable Distribution**:
  - Windows: `1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader` (`RTX5-Terminal64.exe`).
  - Linux Ubuntu 24.04 VPS: `.deb` packages (`rtx5-superadmin`, `rtx5-broker`, `rtx5-web-terminal`) under `/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`.

---

## 4. Exact Wire Protocol & Binary Frame Reference (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)

- **Encryption & Handshake**:
  - `X25519 ECDH` ephemeral key exchange + `HKDF-SHA256` session key derivation + `AES-256-GCM` authenticated encryption with monotonic 64-bit sequence numbers, 32-byte CSPRNG challenge-response nonces, `TCP_NODELAY`, strict Peer-IP lock, single-session HWID/DPAPI lock, and 60-second Ed25519-signed `ExecutionLease` (`MaxEncryptedFrameBytes = 32 MB`).
- **Exact Binary Frame Payloads**:
  - `0x16 / 0x17`: `FrameBrokerDirectoryReq` / `FrameBrokerDirectoryResp` (`.srv` Broker Discovery on `:9100`).
  - `0x21 FrameTickBatch`: Fixed **48-byte** `BinaryTick` structs (`Symbol[16]`, `TimestampMs int64`, `Bid float64`, `Ask float64`, `Sequence uint64` / spread derived).
  - `0x22 FrameCandleBatch`: Fixed **72-byte** (wire) / **64-byte** (stream) `BinaryCandle` structs (`Symbol[16]`, `Timeframe[8]`, `TimeSec int64`, `O`, `H`, `L`, `C`, `Vol float64`).
  - `0x38 FrameBinaryOrderFastReq`: Fixed **128-byte** (132-byte with `ReqID` on `/__rtx5_binary_order_ws`) binary order struct for all 6 MT5 actions (`1=PlaceMarket`, `2=ClosePosition`, `3=ModifyPosition`, `4=PlacePending`, `5=ModifyPending`, `6=CancelPending`, plus `7=CloseBulk`).
  - `0x39 FrameBinaryOrderFastResp`: Fixed **136-byte** (140-byte on `/__rtx5_binary_order_ws`) binary execution response (`Status`, `OrderTicket`, `PositionTicket`, `DealTicket`, `FillPrice`, `ExecutedVol`, `RealizedPnL`, `ExecMicros`, `ErrorCode`, `Message`).
  - `0x3A FrameBinaryTradeEvent` & `0x3B FrameBinaryAccountSub`: Real-time private push stream for `Account`, `Positions`, `Orders`, `Deals`, and `Metrics`.
  - `0x34â€“0x37 Binary OTA Frames`: Ed25519-signed manifest + SHA-256 chunked UI/binary OTA delivery.
  - Internal `127.0.0.1:8190` (`RTO\x01` / `RTO\x02`): 32-socket persistent `TCP_NODELAY` raw binary order pool between `:4443` / `:8443` and `rtx5-gateway`.

---

## 5. Live Broker `yo4x` (`185.126.217.108:4443`), `broker.lic`, & `:9100` Binary TCP Auto-Push OTA

- **Live Production Broker**:
  - `broker_id`: `yo4x`
  - `broker_name`: `yo4x`
  - Broker Access Server TCP: `185.126.217.108:4443`
  - Super Admin Discovery & OTA Hub TCP: `185.126.217.108:9100`
  - Web Terminal URL: `https://tcp-terminal.orrnn.com` (listening on `:8443`, co-located with `:8190` `RTO\x01` Fast-Lane Engine).
  - License Path on VPS: `/opt/rtx5-broker/config/broker.lic` (Ed25519-signed by Super Admin).
- **Staging & OTA Auto-Push Flow**:
  - `05-stage-and-build-uis.ps1` builds `Broker-Terminal-UI-TCP` with `VITE_APP_VERSION=2.2.4` and stages `dist/` into **both** `desktop-clients/cmd/rtx5-terminal-client/dist` and `web-terminal-tcp/server/dist`.
  - `publish-ota-release.ps1 -Channel all -Version "2.2.4"` signs `terminal-ui-dist.zip`, `RTX5-Terminal64.exe`, and `web-terminal-linux.zip` with the Master Ed25519 key and uploads them over `:9100` (`POST /api/tcp-security/ota/upload`), updating both Windows Desktop traders and `https://tcp-terminal.orrnn.com`.
---

## CRITICAL DESKTOP .EXE & PACKAGING ANTI-REGRESSION RULES (DO NOT REPEAT)

1. **Canonical Desktop .EXE Build Directory is Strictly 2-TCP-Codebase\build\clients\**:
   -  6-build-desktop-clients.ps1 compiles all 4 Windows 64-bit apps (RTX5-SuperAdmin64.exe, RTX5-Admin64.exe, RTX5-Manager64.exe, RTX5-Terminal64.exe) into **2-TCP-Codebase\build\clients\** using -ldflags="-s -w -H=windowsgui".
   - **NEVER** use, create, or copy from uild\desktop-clients\ (an obsolete legacy folder that held old non-windowsgui console builds that opened a black cmd.exe window and external Microsoft Edge tabs).
2. **Native Win32 WebView2 Window Only (clientcore/window_windows.go)**:
   - All 4 Windows .exe apps launch inside an in-process **Native Win32 WebView2 Window** (unNativeWin32Window via github.com/jchv/go-webview2) with -H=windowsgui — **ZERO** black console windows, **ZERO** external Edge/Chrome browser tabs, and **ZERO** browser sync/extension popups.
3. **Keep Package Folders Clean of .running_old / .old / Obsolete Binaries**:
   - Never leave *.running_old, *.old, tx5-fix-receiver, or tx5-webterminal inside 3-EXE-Packages-To-Run-And-Share\.
   - For web-terminal-linux.zip, the Linux Web Terminal source directory is strictly 2-TCP-Codebase\web-terminal-tcp\server (never desktop-clients\cmd\rtx5-web-terminal-server).
