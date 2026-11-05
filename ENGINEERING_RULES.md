# ENGINEERING_RULES.md — `Broker-Terminal-UI-TCP` (`v2.2.4`)

> **🚨 RULE #1 — STRICT CI/CD LOCK**:
> **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

---

## 1. Dual-Mode Pure Binary TCP Architecture Rules

`Broker-Terminal-UI-TCP` powers **BOTH** the Windows 64-Bit Native Desktop Trader (`RTX5-Terminal64.exe`) and the Linux Pure Binary TCP Web Terminal (`rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com`).

1. **Zero Public Cloud WebSockets / Preserve Binary Fast-Lanes**:
   - All 6 MT5 trading actions (plus bulk close) MUST execute through `src/services/binaryTcpOrderClient.ts` (`/__rtx5_binary_order_ws` 132-byte binary frame -> `:4443` / `:8190` 256-Shard RAM + WAL Engine in `< 0.5 ms`).
   - All market data (`0x21` ticks, `0x22` candles) and private account/position/order/deal push events (`0x3A`) MUST stream through `src/services/binaryTcpMarketStream.ts` (`GET /__rtx5_binary_stream` + `POST /__rtx5_binary_account_sub`).
   - Never replace `/__rtx5_binary_order_ws`, `binaryTcpOrderClient`, `binaryTcpMarketStream`, or `/api/tcp-client/*` loopback bridges with legacy cloud WebSockets.
2. **Dynamic Broker Discovery & Zero Hardcoded Identities**:
   - Never hardcode broker names (`FXTrust`, `RTX5-Demo`), server URLs, or stale versions (`v1.0.3`, `v1.0.0`).
   - Always query `/api/tcp-client/brokers` and `/api/tcp-client/status` for dynamic `.srv` broker discovery (`:9100` -> `:4443`, e.g., live broker `yo4x` at `185.126.217.108:4443`) and read `VITE_APP_VERSION` / `package.json` version (`v2.2.4`).
3. **Hardware Security (`rtx5_guard.dll`)**:
   - Never modify, bypass, stub, or recompile `rtx5_guard.dll`.

---

## 2. Full Tech Stack & Packaging Rationale (`.exe` & `.deb`)

- **Backend Stack**: Go 1.24 (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"` for static Linux binaries; Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation `rtx5_guard.dll` for Windows 64-bit `.exe` apps), PostgreSQL 16 (pipelined `pgx v5.9.0 SendBatch` + Async WAL + idempotent `broker-schema-compat.sql`), 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`), and local-only (`127.0.0.1`) Redis/NATS buses.
- **Frontend Stack**: React 19 + TypeScript/JavaScript + Vite + Zustand (`O(1)` reference checks + `requestAnimationFrame` coalescing), embedded via Go `embed.FS` directly inside `RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`, and `rtx5-web-terminal-server` (`https://tcp-terminal.orrnn.com`).
- **Why `.exe` & `.deb` Are Built This Way**:
  - Eliminates browser extension interference (`--disable-extensions` + isolated `%LOCALAPPDATA%\RTX5-Desktop-Profiles\<app>`).
  - Eliminates public HTTP/WebSocket latency and attack surfaces.
  - Enforces hardware-locked DPAPI/HWID session binding.
  - Provides 1-file portable Windows distribution (`1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader`).
  - Provides 1-command Ubuntu 24.04 Linux VPS installation (`rtx5-superadmin`, `rtx5-broker`, `rtx5-web-terminal` under `/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`).

---

## 3. Wire Protocol & Binary Frame Specifications (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)

- **Encryption & Handshake**: `X25519 ECDH` ephemeral key exchange + `HKDF-SHA256` session key derivation + `AES-256-GCM` authenticated encryption with monotonic 64-bit sequence numbers, 32-byte CSPRNG challenge-response nonces, `TCP_NODELAY`, strict Peer-IP lock, single-session HWID/DPAPI lock, and 60-second Ed25519-signed `ExecutionLease` (`MaxEncryptedFrameBytes = 32 MB`).
- **Binary Frame Layouts**:
  - `0x21 FrameTickBatch`: Fixed **48-byte** `BinaryTick` structs (`Symbol[16]`, `TimestampMs int64`, `Bid float64`, `Ask float64`, `Sequence uint64` / spread derived).
  - `0x22 FrameCandleBatch`: Fixed **72-byte** (wire) / **64-byte** (stream) `BinaryCandle` structs (`Symbol[16]`, `Timeframe[8]`, `TimeSec int64`, `O`, `H`, `L`, `C`, `Vol float64`).
  - `0x38 FrameBinaryOrderFastReq`: Fixed **128-byte** (132-byte with `ReqID` on `/__rtx5_binary_order_ws`) binary order struct for all 6 MT5 actions (`1=PlaceMarket`, `2=ClosePosition`, `3=ModifyPosition`, `4=PlacePending`, `5=ModifyPending`, `6=CancelPending`).
  - `0x39 FrameBinaryOrderFastResp`: Fixed **136-byte** (140-byte on `/__rtx5_binary_order_ws`) binary execution response (`Status`, `OrderTicket`, `PositionTicket`, `DealTicket`, `FillPrice`, `ExecutedVol`, `RealizedPnL`, `ExecMicros`, `ErrorCode`, `Message`).
  - `0x3A FrameBinaryTradeEvent` & `0x3B FrameBinaryAccountSub`: Real-time private push stream for `Account`, `Positions`, `Orders`, `Deals`, and `Metrics`.
  - `0x34–0x37 Binary OTA Frames`: Ed25519-signed manifest + SHA-256 chunked UI/binary OTA delivery.
  - Internal `127.0.0.1:8190` (`RTO\x01` / `RTO\x02`): 32-socket persistent `TCP_NODELAY` raw binary order pool between `:4443` / `:8443` and `rtx5-gateway`.

---

## 4. End-to-End Provisioning, `broker.lic`, & `:9100` OTA Release Rules

1. **Broker Registration & `broker.lic`**:
   - Register broker in `RTX5-SuperAdmin64.exe` (e.g., `broker_id: yo4x`, `185.126.217.108:4443`, Hub `185.126.217.108:9100`).
   - Generate Ed25519-signed `broker.lic` and install at `/opt/rtx5-broker/config/broker.lic`.
   - Verify `.srv` discovery updates dynamically across Admin, Manager, and Terminal UIs.
2. **Build & Stage Both Targets**:
   - Run `05-stage-and-build-uis.ps1` to build `dist/`, stage into both `desktop-clients/cmd/rtx5-terminal-client/dist` and `web-terminal-tcp/server/dist`, and create `terminal-ui-dist.zip` + `web-terminal-linux.zip`.
3. **Publish Ed25519-Signed `:9100` OTA**:
   - Run `publish-ota-release.ps1 -Channel all -Version "2.2.4"` (or use `RTX5_MASTER_PRIV_HEX` in approved CI/CD) to push over `:9100` (`POST /api/tcp-security/ota/upload`).

---

## 5. Mandatory Post-Change Verification & Request-Flooding Stress Suite

After **EVERY** code change, run:
1. `npm test` & `npm run build:desktop`
2. `cmd/verify_ota_and_versions`
3. `cmd/verify_sub05ms_calc_sync` — Verifies `< 0.5 ms` (`18–350 µs` server exec) 256-Shard RAM + Binary `.WAL` order execution and exact MT5 financial math (`Margin`, `FreeMargin`, `Equity`, `FloatingPnL`).
4. `cmd/sandbox_flood_crash_stress` (plus `bench_concurrent_live.exe`, `sim_binary_wire_saturation.exe`, `sim_100m_traders.exe`) — Verifies request-flooding resilience (1,000+ rapid-fire concurrent orders, 64+ simultaneous trader sockets, malformed binary frame fuzzing, abrupt socket disconnect floods, `503 SERVER_BUSY` backpressure without OOM/crash, zero `40P01` deadlocks, and 100% WAL + PostgreSQL crash recovery).
