# CLAUDE.md — Claude Code Instructions for `Broker-Terminal-UI-TCP` (`v2.2.4`)

> **🚨 TOP-PRIORITY RULE — STRICT CI/CD LOCK**:
> **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

Read `AGENTS.md`, `PROJECT_MEMORY.md`, and `ENGINEERING_RULES.md` before making any changes in this repository.

---

## 1. Dual-Target Architecture (`RTX5-Terminal64.exe` & `https://tcp-terminal.orrnn.com`)

`Broker-Terminal-UI-TCP` (`v2.2.4`) powers **BOTH**:
1. **Windows 64-Bit Native Desktop Trader (`RTX5-Terminal64.exe`)** (`desktop-clients/cmd/rtx5-terminal-client/dist` + `terminal-ui-dist.zip`)
2. **Linux Pure Binary TCP Web Terminal (`rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com`)** (`web-terminal-tcp/server/dist` + `web-terminal-server/` + `web-terminal-linux.zip`)

### Full Tech Stack & Packaging Rationale
- **Backend Stack**: Go 1.24 (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"` for static Linux binaries; Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation `rtx5_guard.dll` for Windows 64-bit `.exe` apps), PostgreSQL 16 (pipelined `pgx v5.9.0 SendBatch` + Async WAL + idempotent `broker-schema-compat.sql`), 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`), and local-only (`127.0.0.1`) Redis/NATS buses.
- **Frontend Stack**: React 19 + TypeScript + Vite (`tsc -b && vite build --mode desktop`) + Lightweight Charts + Zustand (`O(1)` reference checks + `requestAnimationFrame` coalescing), embedded via Go `embed.FS` inside `RTX5-Terminal64.exe` and `rtx5-web-terminal-server`.
- **Why `.exe` & `.deb` Are Built This Way**: Eliminates browser extension interference (`--disable-extensions` + isolated `%LOCALAPPDATA%\RTX5-Desktop-Profiles\terminal`), eliminates public HTTP/WebSocket latency and attack surfaces, enforces hardware-locked DPAPI/HWID session binding, provides 1-file portable Windows distribution (`1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader`), and provides 1-command Ubuntu 24.04 Linux VPS installation (`rtx5-superadmin`, `rtx5-broker`, `rtx5-web-terminal` under `/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`).

---

## 2. Strict Rules for Claude

1. **CI/CD Lock**: **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**
2. **Preserve Pure Binary TCP Fast-Lanes**:
   - Never replace `/__rtx5_binary_order_ws` (132-byte binary order frame -> `:4443` / `:8190` 256-Shard RAM + WAL Engine in `< 0.5 ms`), `/__rtx5_binary_stream` (`0x21` ticks, `0x22` candles, `0x3A` private account/position/order/deal push events), `/__rtx5_binary_account_sub` (`0x3B`), `binaryTcpOrderClient.ts`, `binaryTcpMarketStream.ts`, or `/api/tcp-client/*` loopback bridges with legacy cloud WebSockets.
3. **Dynamic Broker & Version Resolution**:
   - Never hardcode broker names (`FXTrust`, `RTX5-Demo`) or versions (`v1.0.3`, `v1.0.0`).
   - Always resolve brokers dynamically via `:9100` -> `:4443` `.srv` discovery (live broker `yo4x` at `185.126.217.108:4443`) and read `VITE_APP_VERSION` / `package.json` version (`v2.2.4`).
4. **Hardware Attestation Lock**:
   - Never modify, stub, or recompile `rtx5_guard.dll`.
5. **Protocol & Binary Frame Integrity (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)**:
   - Encryption: `X25519 ECDH` + `HKDF-SHA256` + `AES-256-GCM` with 64-bit monotonic sequence numbers, 32-byte CSPRNG challenge-response nonces, `TCP_NODELAY`, Peer-IP lock, single-session HWID/DPAPI lock, and 60s Ed25519 `ExecutionLease` (`MaxEncryptedFrameBytes = 32 MB`).
   - Frames: `0x21` (48B `BinaryTick`), `0x22` (72B wire / 64B stream `BinaryCandle`), `0x38` (128B/132B `FrameBinaryOrderFastReq`), `0x39` (136B/140B `FrameBinaryOrderFastResp`), `0x3A/0x3B` (`FrameBinaryTradeEvent` / `FrameBinaryAccountSub`), `0x34–0x37` (Ed25519-signed Binary OTA), and `127.0.0.1:8190` (`RTO\x01`/`RTO\x02` 32-socket raw order pool).
6. **OTA & License Flow**:
   - Brokers are provisioned in `RTX5-SuperAdmin64.exe` with Ed25519-signed `/opt/rtx5-broker/config/broker.lic`.
   - OTA releases (`terminal-ui-dist.zip`, `RTX5-Terminal64.exe`, `web-terminal-linux.zip`) are signed and pushed over `:9100` via `publish-ota-release.ps1 -Channel all -Version "2.2.4"` (`POST /api/tcp-security/ota/upload`).
7. **Mandatory Post-Change Stress Testing**:
   - After every change, run `npm test`, `npm run build:desktop`, and the verification & request-flooding stress suite (`cmd/sandbox_flood_crash_stress`, `cmd/verify_sub05ms_calc_sync`, `cmd/verify_ota_and_versions`, `bench_concurrent_live.exe`, `sim_binary_wire_saturation.exe`, `sim_100m_traders.exe`) to verify `< 0.5 ms` execution, exact MT5 math, and zero deadlocks/crashes under 1,000+ concurrent order floods.
