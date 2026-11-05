# Broker-Terminal-UI-TCP (`v2.2.4`)

**Dual-Target Pure Binary TCP (`:4443` & `RTO\x01` `:8190`) Professional Trader Terminal Repository for the Orrnn-RTX5 Trading Ecosystem.**

> **🔒 STRICT CI/CD LOCK RULE**: **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

---

## 1. Dual-Target Architecture: One Repository Powers BOTH Desktop `.exe` & Linux Web Terminal

**`Broker-Terminal-UI-TCP` is a unified dual-target repository (`npm run build:desktop` / `tsc -b && vite build --mode desktop` + Go `web-terminal-server/`) that powers BOTH production trader runtimes:**

### Target 1: Windows 64-Bit Native Desktop Trader (`RTX5-Terminal64.exe`)
- **Staging & Embedded Path**: `2-TCP-Codebase/desktop-clients/cmd/rtx5-terminal-client/dist`
- **OTA & Release Artifacts**: `RTX5-Terminal64.exe` (`3-TRADER-Share-To-Trader`) + `terminal-ui-dist.zip`
- **How It Works**:
  - The compiled `dist/` bundle is embedded via Go `//go:embed all:dist` into `RTX5-Terminal64.exe` (and hot-updatable via `%LOCALAPPDATA%\RTX5-OTA\terminal-ui\dist`).
  - `RTX5-Terminal64.exe` verifies `rtx5_guard.dll` (Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation), binds an ephemeral loopback bridge (`127.0.0.1:<port>`), dials the selected broker's `:4443` `RTX\x05` (`X25519 + HKDF-SHA256 + AES-256-GCM`) tunnel (plus a dedicated `RoleTraderOrderFastLane` socket), and opens an isolated `--disable-extensions` WebView2/Chromium window.

### Target 2: Linux Pure Binary TCP Web Terminal (`rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com`)
- **Staging & Embedded Path**: `2-TCP-Codebase/web-terminal-tcp/server/dist` (and `web-terminal-server/dist` inside this repository)
- **OTA & Release Artifacts**: `rtx5-web-terminal-server` Linux static binary + `web-terminal-linux.zip` + `rtx5-web-terminal_2.2.4_amd64.deb` (`/root/Rtx-TCP/3-Web-Terminal`)
- **How It Works**:
  - The exact same `dist/` bundle is embedded into the Go `rtx5-web-terminal-server` daemon listening on `:8443` (served directly or behind `https://tcp-terminal.orrnn.com`).
  - When co-located on the Broker VPS (`185.126.217.108`), `rtx5-web-terminal-server` connects **directly** to the local 32-socket `RTO\x01` Binary TCP pool (`127.0.0.1:8190`) and `:8190` push stream for **`0.0 ms` loopback hop (`18–350 µs` server execution)** into the 256-Shard RAM + Binary `.WAL` Engine, while also dialing `:4443` `RTX\x05` and `:9100` for multi-broker `.srv` switching.

---

## 2. Role in the 6-Repo `Orrnn-RTX5` Pure Binary TCP Stack

| # | Repository | Role & Target Artifact |
|---|---|---|
| 1 | `Super-Admin-Commands-TCP` | Central Hub (`rtx5-superadmin-tcp` `:9100`), `.srv` Broker Registry, Ed25519 License Authority (`broker.lic`), Binary OTA Hub, & `RTX5-SuperAdmin64.exe` |
| 2 | `Broker-Commands-TCP` | Broker Backend (`rtx5-server-tcp` `:4443`, `rtx5-gateway` `:8080`/`:8190`, `rtx5-Matching-Engine`, `rtx5-market-feed`, Go `desktop-clients/`) |
| 3 | `Broker-Admin-UI-TCP` | Broker Administrator Control Plane UI (`RTX5-Admin64.exe` + `admin-ui-dist.zip`) |
| 4 | `Broker-Manager-UI-TCP` | Dealing Desk Manager UI (`RTX5-Manager64.exe` + `manager-ui-dist.zip`) |
| 5 | **`Broker-Terminal-UI-TCP`** | **Dual-Mode Trader Terminal UI (`RTX5-Terminal64.exe` + `terminal-ui-dist.zip` AND `rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com` + `web-terminal-linux.zip`) — THIS REPOSITORY** |
| 6 | `Broker-CRM-TCP` | Optional Broker Trader Portal & CRM (`rtx5-crm-tcp`) |

---

## 3. Full Technology Stack & Why `.exe` and `.deb` Packages Are Built This Way

### Frontend & Gateway Stack (`Broker-Terminal-UI-TCP`)
- **Frontend**: React 19 (`^19.2.0`) + TypeScript (`~5.9.3`) + Vite 7 (`tsc -b && vite build --mode desktop`) + Tailwind CSS v4 + Lightweight Charts (`^5.1.0`) + Zustand (`^5.0.10`, `O(1)` reference checks + `requestAnimationFrame` coalescing) + i18next (19 locales).
- **Binary Order Fast-Lane (`src/services/binaryTcpOrderClient.ts`)**: Pre-allocated 132-byte `ArrayBuffer`/`DataView` codec (`/__rtx5_binary_order_ws` & `/__rtx5_binary_order`) with zero JSON serialization.
- **Binary Market & Trade Stream (`src/services/binaryTcpMarketStream.ts`)**: Sliding `Uint8Array` stream reader (`/__rtx5_binary_stream`, `/__rtx5_binary_account_sub`, `/api/v2/binary-candles/{symbol}`) with zero-allocation ASCII symbol interning and order-in-flight VSync deferral.
- **Web Terminal Go Server (`web-terminal-server/`)**: Go 1.24 server (`main.go`, `binary_order_bridge.go`, `binary_stream.go`, `tcp_toolbar.js`) bridging browser tabs to `:8190` (`RTO\x01`) and `:4443` (`RTX\x05`) with strict per-session/per-WebSocket JWT & `AccountLogin` isolation.

### Backend & Native Desktop Stack
- **Go 1.24**: Static Linux binaries (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"`) and Windows 64-bit native launchers (`RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`).
- **Hardware Security (`rtx5_guard.dll`)**: Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation.
- **Execution Core**: 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`), PostgreSQL 16 (pipelined `pgx v5.9.0 SendBatch` + Async WAL + idempotent `broker-schema-compat.sql`), and local-only (`127.0.0.1`) Redis/NATS buses.

### Why `.exe` and `.deb` Packages Are Built This Way
1. **Zero Browser Extension Interference**: Native Windows `.exe` launchers run with `--disable-extensions` and isolated `%LOCALAPPDATA%\RTX5-Desktop-Profiles\terminal` profiles so extensions cannot inject scripts or slow down WebGL/Canvas chart rendering.
2. **Zero Public HTTP/WebSocket Latency & Attack Surface**: Eliminates JSON parsing overhead, Cloudflare buffering, and public REST exposure.
3. **Hardware-Locked DPAPI/HWID Session Binding**: `rtx5_guard.dll` binds trader credentials to the host hardware.
4. **1-File Portable Windows Distribution**: Organized into `1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, and `3-TRADER-Share-To-Trader` (`RTX5-Terminal64.exe`).
5. **1-Command Ubuntu 24.04 Linux VPS Installation**: Debian `.deb` packages (`rtx5-superadmin`, `rtx5-broker`, `rtx5-web-terminal`) install cleanly under `/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`.

---

## 4. How `/__rtx5_binary_order_ws` & `/__rtx5_binary_stream` Work in Both Desktop `.exe` & Web Terminal Modes

### A. `/__rtx5_binary_order_ws` (132-Byte Binary Order Fast-Lane -> `< 0.5 ms` Execution)
1. **JWT Pre-Binding (`reqId = 0`)**:
   - On login or token refresh, `syncBinaryOrderAuthToken()` sends a 1-time pre-bind binary frame (`[reqId=0 : u32_le][tokenLen : u16_le][JWT UTF-8]`) over `/__rtx5_binary_order_ws`.
2. **Zero-Allocation 132-Byte Order Click (`reqId >= 1`)**:
   - Every market order, position close, SL/TP modify, pending order placement/modification/cancellation, or bulk close writes directly into a pre-allocated **132-byte** `ArrayBuffer` (`4-byte Little-Endian reqId` + `128-byte BinaryOrderFastReq` header, **0 JWT bytes on the hot path**).
3. **Routing in Desktop (`RTX5-Terminal64.exe`) vs. Web Terminal (`rtx5-web-terminal-server`)**:
   - **Desktop `.exe` Mode**: Local Go daemon reads the 132-byte WS frame on `127.0.0.1`, attaches the pre-bound JWT, and transmits `0x38 FrameBinaryOrderFastReq` over the pre-warmed `:4443` `RoleTraderOrderFastLane` tunnel -> `rtx5-server-tcp` -> `:8190` `RTO\x01` 32-socket pool -> 256-Shard `RAMMT5Engine` + Binary `.WAL`.
   - **Web Terminal Mode (`https://tcp-terminal.orrnn.com`)**: `web-terminal-server/binary_order_bridge.go` (`32` worker goroutines per connection, strict per-connection `connToken` + `rtx5_wt_sid` cookie isolation) dispatches the binary frame **directly** over the local `:8190` `RTO\x01` 32-socket pool (`RawGatewayExecuteBinaryOrder`) when targeting the local broker VPS (`0.0 ms` network hop), or over `:4443` `RoleTraderOrderFastLane` when connected to a remote broker.
4. **140-Byte Binary Fill Response**:
   - The engine returns a **136-byte** `BinaryOrderFastResp` (`140 bytes` with `4-byte reqId` over WS) containing `Status`, `ExecMicros` (`18–350 µs`), `OrderTicket`, `PositionTicket`, `DealTicket`, `FillPrice`, `Volume`, `Profit`, `Commission`, `SL`, `TP`, `Symbol[16]`, and `ClientOrderID[40]`.

### B. `/__rtx5_binary_stream` (`0x21` Ticks, `0x22` Candles, `0x3A` Private Trade Events)
1. **Single Persistent `application/octet-stream` Reader**:
   - `binaryTcpMarketStream.ts` opens `GET /__rtx5_binary_stream` via `fetch()` + `ReadableStreamDefaultReader` and reassembles frames in a zero-alloc 128 KB sliding `Uint8Array` buffer (`[frameType : u8][reserved : u8][payloadLen : u16_le][payload]`).
2. **Account Binding (`POST /__rtx5_binary_account_sub`)**:
   - Sends `[AccountLogin : i64_le][TokenLen : u16_le][Token UTF-8]` (`0x3B FrameBinaryAccountSub`).
   - In Web Terminal mode (`web-terminal-server/binary_stream.go`), `broadcastTradeEvent()` inspects `payload[2:10]` (`AccountLogin`) and strictly isolates `0x3A` private events per browser session (`rtx5_wt_sid`) so a trader tab only ever receives its own account's events.
3. **Frame Types**:
   - **`0x21 FrameBinaryTickBatch`**: `[count : u16_le]` + `count * 48-byte BinaryTick` (`Symbol[16]`, `TimestampMs i64_le`, `Bid f64_le`, `Ask f64_le`, `Sequence u64_le`). Dispatched synchronously via `onDirectChartTick()` to the active chart canvas.
   - **`0x22 FrameBinaryCandleBatch`**: Live OHLCV candle updates (`64-byte` stream records / `72-byte` wire structs). Historical candles load via `GET /api/v2/binary-candles/{symbol}` (`fetchBinaryCandles()`).
   - **`0x3A FrameBinaryTradeEvent`**: Priority-queued (`prioCh`) private account push events (`eventKind`: `1=positions`, `2=orders`, `3=account`, `4=metrics`, `5=deals`, `6=state`).

---

## 5. Exact Wire Protocol, Binary Data Formats, & Encryption (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)

- **Encryption & Handshake**:
  - `X25519 ECDH` ephemeral key exchange + `HKDF-SHA256` session key derivation + `AES-256-GCM` authenticated encryption with monotonic 64-bit sequence numbers, 32-byte CSPRNG challenge-response nonces, `TCP_NODELAY`, strict Peer-IP lock, single-session HWID/DPAPI lock, and 60-second Ed25519-signed `ExecutionLease` (`MaxEncryptedFrameBytes = 32 MB`).
- **Exact Binary Frame Payloads**:
  - `0x21 FrameTickBatch`: Fixed **48-byte** `BinaryTick` structs (`Symbol[16]`, `TimestampMs int64`, `Bid float64`, `Ask float64`, `Sequence uint64` / spread derived).
  - `0x22 FrameCandleBatch`: Fixed **72-byte** (wire) / **64-byte** (stream) `BinaryCandle` structs (`Symbol[16]`, `Timeframe[8]`, `TimeSec int64`, `O`, `H`, `L`, `C`, `Vol float64`).
  - `0x38 FrameBinaryOrderFastReq`: Fixed **128-byte** (132-byte with `ReqID` on `/__rtx5_binary_order_ws`) binary order struct for all 6 MT5 actions (`1=PlaceMarket`, `2=ClosePosition`, `3=ModifyPosition`, `4=PlacePending`, `5=ModifyPending`, `6=CancelPending`, plus `7=CloseBulk`).
  - `0x39 FrameBinaryOrderFastResp`: Fixed **136-byte** (140-byte on `/__rtx5_binary_order_ws`) binary execution response (`Status`, `OrderTicket`, `PositionTicket`, `DealTicket`, `FillPrice`, `ExecutedVol`, `RealizedPnL`, `ExecMicros`, `ErrorCode`, `Message`).
  - `0x3A FrameBinaryTradeEvent` & `0x3B FrameBinaryAccountSub`: Real-time private push stream for `Account`, `Positions`, `Orders`, `Deals`, and `Metrics`.
  - `0x34–0x37 Binary OTA Frames`: Ed25519-signed manifest + SHA-256 chunked UI/binary OTA delivery.
  - Internal `127.0.0.1:8190` (`RTO\x01` / `RTO\x02`): 32-socket persistent `TCP_NODELAY` raw binary order pool between `:4443` / `:8443` and `rtx5-gateway`.

---

## 6. Dynamic `.srv` Broker Discovery (`:9100` -> `:4443`), `broker.lic`, & `:9100` Binary TCP OTA Auto-Push

1. **Provisioning & `broker.lic`**:
   - Brokers (e.g., live broker **`yo4x`** at `185.126.217.108:4443`, Hub `185.126.217.108:9100`) are registered in `RTX5-SuperAdmin64.exe`, which generates an Ed25519-signed `/opt/rtx5-broker/config/broker.lic`.
   - Both `RTX5-Terminal64.exe` and `rtx5-web-terminal-server` poll Super Admin `:9100` (`0x16 FrameBrokerDirectoryReq` -> `0x17 FrameBrokerDirectoryResp`) and expose `/api/tcp-client/brokers` and `/api/tcp-client/connect` so the Terminal Login Modal & top Binary TCP bar dynamically list `yo4x` with zero hardcoded broker names.
2. **Live `v2.2.4` Version Display**:
   - `VITE_APP_VERSION`, `package.json`, `VERSION`, and `tcp_toolbar.js` display `v2.2.4` live across both `RTX5-Terminal64.exe` and `https://tcp-terminal.orrnn.com`.
3. **Direct `:9100` Binary TCP Ed25519 OTA Auto-Push**:
   - Run `publish-ota-release.ps1 -Channel all -Version "2.2.4"` (or via `RTX5_MASTER_PRIV_HEX` in approved CI/CD).
   - Signs and uploads `terminal-ui-dist.zip`, `RTX5-Terminal64.exe`, and `web-terminal-linux.zip` over `:9100` (`POST /api/tcp-security/ota/upload`), hot-updating desktop clients and hot-restarting `rtx5-web-terminal` on the Linux VPS.

---

## 7. Quick Start & Build Commands

```bash
# Install dependencies
npm ci

# Local development mode
npm run dev:desktop

# Build production bundle (used by BOTH RTX5-Terminal64.exe and rtx5-web-terminal-server)
npm run build:desktop

# Build the Go Web Terminal TCP Server
cd web-terminal-server && go build -o rtx5-web-terminal-server .

# Run unit tests
npm test
```

---

## 8. Mandatory Post-Change Verification & Stress Suite

After **EVERY** code change, developers and AI agents **MUST** run the verification and request-flooding stress suite from `2-TCP-Codebase/desktop-clients`:

1. `go run ./cmd/verify_ota_and_versions` — Verifies live `v2.2.4` version parity, `yo4x` discovery, and OTA manifest signatures across Desktop and `https://tcp-terminal.orrnn.com`.
2. `go run ./cmd/verify_sub05ms_calc_sync` — Verifies `< 0.5 ms` (`18–350 µs` server exec) 256-Shard RAM + Binary `.WAL` order execution and exact MT5 financial math (`Margin`, `FreeMargin`, `Equity`, `FloatingPnL`).
3. `go run ./cmd/sandbox_flood_crash_stress` (plus `bench_concurrent_live.exe`, `sim_binary_wire_saturation.exe`, `sim_100m_traders.exe`) — Verifies request-flooding resilience (1,000+ rapid-fire concurrent orders, 64+ simultaneous trader sockets, malformed binary frame fuzzing, abrupt socket disconnect floods, `503 SERVER_BUSY` backpressure without OOM/crash, zero `40P01` deadlocks, and 100% WAL + PostgreSQL crash recovery).
