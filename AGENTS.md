# AGENTS.md — AI Agent Engineering Rules for `Broker-Terminal-UI-TCP` (`v2.2.4`)

> **🚨 TOP-PRIORITY RULE — STRICT CI/CD LOCK**:
> **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

---

## 1. Dual-Target Repository Identity (`RTX5-Terminal64.exe` + `https://tcp-terminal.orrnn.com`)

**`Broker-Terminal-UI-TCP` (`v2.2.4`) is a single unified repository that powers BOTH:**
1. **Windows 64-Bit Native Desktop Trader (`RTX5-Terminal64.exe`)** (`desktop-clients/cmd/rtx5-terminal-client/dist` + `terminal-ui-dist.zip`)
2. **Linux Pure Binary TCP Web Terminal (`rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com`)** (`web-terminal-tcp/server/dist` + `web-terminal-server/` + `web-terminal-linux.zip`)

### Full Tech Stack & Why `.exe` and `.deb` Packages Are Built This Way
- **Backend Stack**: Go 1.24 (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"` for static Linux binaries; Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation `rtx5_guard.dll` for Windows 64-bit `.exe` apps), PostgreSQL 16 (pipelined `pgx v5.9.0 SendBatch` + Async WAL + idempotent `broker-schema-compat.sql`), 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`), and local-only (`127.0.0.1`) Redis/NATS buses.
- **Frontend Stack**: React 19 + TypeScript + Vite (`tsc -b && vite build --mode desktop`) + Lightweight Charts + Zustand (`O(1)` reference checks + `requestAnimationFrame` coalescing), embedded via Go `embed.FS` directly inside `RTX5-Terminal64.exe` and `rtx5-web-terminal-server` (`https://tcp-terminal.orrnn.com`).
- **Why `.exe` & `.deb` Are Built This Way**: Eliminates browser extension interference (`--disable-extensions` + isolated `%LOCALAPPDATA%\RTX5-Desktop-Profiles\terminal`), eliminates public HTTP/WebSocket latency and attack surfaces, enforces hardware-locked DPAPI/HWID session binding, provides 1-file portable Windows distribution (`1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader`), and provides 1-command Ubuntu 24.04 Linux VPS installation (`rtx5-superadmin`, `rtx5-broker`, `rtx5-web-terminal` under `/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`).

---

## 2. Non-Negotiable Agent Rules (Forbidden Actions)

1. **NEVER Edit or Create CI/CD Workflows**:
   - **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**
2. **NEVER Replace Binary TCP Order or Stream Clients with Legacy Cloud WebSockets**:
   - Never replace `/__rtx5_binary_order_ws`, `/__rtx5_binary_order`, `/__rtx5_binary_stream`, `/__rtx5_binary_account_sub`, `binaryTcpOrderClient.ts`, `binaryTcpMarketStream.ts`, or `/api/tcp-client/*` loopback bridges with legacy public `wss://` or JSON REST endpoints.
3. **NEVER Hardcode Broker Names or Versions**:
   - Never hardcode broker names (`FXTrust`, `RTX5-Demo`) or stale versions (`v1.0.3`, `v1.0.0`).
   - Always resolve brokers dynamically via `:9100` -> `:4443` `.srv` discovery (live broker `yo4x` on `185.126.217.108:4443`) and read `VITE_APP_VERSION` / `package.json` version (`v2.2.4`).
4. **NEVER Modify or Recompile `rtx5_guard.dll`**:
   - Never patch, stub, bypass, or recompile `rtx5_guard.dll`.
5. **NEVER Break Dual-Mode Parity (`Desktop .exe` vs `Web Terminal`)**:
   - Every change in `src/` or `web-terminal-server/` must work seamlessly in both `RTX5-Terminal64.exe` and `rtx5-web-terminal-server` (`https://tcp-terminal.orrnn.com`), and must be kept in sync with `2-TCP-Codebase/ui-overrides/terminal-ui/` and `2-TCP-Codebase/web-terminal-tcp/server/`.

---

## 3. Exact Wire Protocol & Binary Frame Specifications (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)

- **Encryption & Handshake**: `X25519 ECDH` ephemeral key exchange + `HKDF-SHA256` session key derivation + `AES-256-GCM` authenticated encryption with monotonic 64-bit sequence numbers, 32-byte CSPRNG challenge-response nonces, `TCP_NODELAY`, strict Peer-IP lock, single-session HWID/DPAPI lock, and 60-second Ed25519-signed `ExecutionLease` (`MaxEncryptedFrameBytes = 32 MB`).
- **Exact Binary Frame Payloads**:
  - `0x21 FrameTickBatch`: Fixed **48-byte** `BinaryTick` structs (`Symbol[16]`, `TimestampMs int64`, `Bid float64`, `Ask float64`, `Sequence uint64` / spread derived).
  - `0x22 FrameCandleBatch`: Fixed **72-byte** (wire) / **64-byte** (stream) `BinaryCandle` structs (`Symbol[16]`, `Timeframe[8]`, `TimeSec int64`, `O`, `H`, `L`, `C`, `Vol float64`).
  - `0x38 FrameBinaryOrderFastReq`: Fixed **128-byte** (132-byte with `ReqID` on `/__rtx5_binary_order_ws`) binary order struct for all 6 MT5 actions (`1=PlaceMarket`, `2=ClosePosition`, `3=ModifyPosition`, `4=PlacePending`, `5=ModifyPending`, `6=CancelPending`, plus `7=CloseBulk`).
  - `0x39 FrameBinaryOrderFastResp`: Fixed **136-byte** (140-byte on `/__rtx5_binary_order_ws`) binary execution response (`Status`, `OrderTicket`, `PositionTicket`, `DealTicket`, `FillPrice`, `ExecutedVol`, `RealizedPnL`, `ExecMicros`, `ErrorCode`, `Message`).
  - `0x3A FrameBinaryTradeEvent` & `0x3B FrameBinaryAccountSub`: Real-time private push stream for `Account`, `Positions`, `Orders`, `Deals`, and `Metrics`.
  - `0x34–0x37 Binary OTA Frames`: Ed25519-signed manifest + SHA-256 chunked UI/binary OTA delivery.
  - Internal `127.0.0.1:8190` (`RTO\x01` / `RTO\x02`): 32-socket persistent `TCP_NODELAY` raw binary order pool between `:4443` / `:8443` and `rtx5-gateway`.

---

## 4. Build, Version-Bump, License (`broker.lic`), & `:9100` Binary TCP OTA Workflow

1. **Broker Provisioning & `broker.lic`**:
   - Brokers (e.g., `broker_id: yo4x`, `185.126.217.108:4443`, Hub `185.126.217.108:9100`) are registered in `RTX5-SuperAdmin64.exe`, which generates an Ed25519-signed `/opt/rtx5-broker/config/broker.lic`.
   - Active brokers are dynamically served via `:9100` `.srv` discovery to Admin, Manager, and Terminal UIs.
2. **Build & Stage Both Desktop `.exe` & Web Terminal**:
   ```powershell
   # Inside Broker-Terminal-UI-TCP:
   npm run build:desktop
   # Or run the full orchestrator staging pipeline (stages both rtx5-terminal-client/dist and web-terminal-tcp/server/dist):
   pwsh -File d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\05-stage-and-build-uis.ps1
   ```
3. **Trigger Ed25519-Signed `:9100` Binary TCP OTA Update**:
   ```powershell
   pwsh -File d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1 -Channel all -Version "2.2.4"
   ```
   (Pushes `terminal-ui-dist.zip`, `RTX5-Terminal64.exe`, and `web-terminal-linux.zip` over `:9100` `POST /api/tcp-security/ota/upload`.)

---

## 5. Mandatory Post-Change Testing: Request-Flooding, Crash Resilience, & Sub-0.5ms Latency Stress Suite

After **EVERY** code change, developers and AI agents **MUST** run the verification & request-flooding stress tests:
- `cmd/sandbox_flood_crash_stress`
- `cmd/verify_sub05ms_calc_sync`
- `cmd/verify_ota_and_versions`
- `bench_concurrent_live.exe`, `sim_binary_wire_saturation.exe`, `sim_100m_traders.exe`

These suites verify:
- `< 0.5 ms` (`18–350 µs` server exec) 256-Shard RAM + Binary `.WAL` order execution and exact MT5 financial math (`Margin`, `FreeMargin`, `Equity`, `FloatingPnL`).
- Request-flooding resilience: 1,000+ rapid-fire concurrent orders, 64+ simultaneous trader sockets, malformed binary frame fuzzing, abrupt socket disconnect floods, `503 SERVER_BUSY` backpressure without OOM/crash, zero `40P01` deadlocks, and 100% WAL + PostgreSQL crash recovery.
