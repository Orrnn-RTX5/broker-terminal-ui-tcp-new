# GEMINI.md — Gemini / Antigravity Agent Instructions for `Broker-Terminal-UI-TCP` (`v2.2.4`)

> **🚨 TOP-PRIORITY RULE — STRICT CI/CD LOCK**:
> **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**

Always review `AGENTS.md`, `PROJECT_MEMORY.md`, and `ENGINEERING_RULES.md` before modifying any file in this repository.

---

## 1. Dual-Target System Overview & Stack

`Broker-Terminal-UI-TCP` (`v2.2.4`) is a single unified repository that powers **BOTH**:
1. **Windows 64-Bit Native Desktop Trader (`RTX5-Terminal64.exe`)** (`desktop-clients/cmd/rtx5-terminal-client/dist` + `terminal-ui-dist.zip`)
2. **Linux Pure Binary TCP Web Terminal (`rtx5-web-terminal-server` at `https://tcp-terminal.orrnn.com`)** (`web-terminal-tcp/server/dist` + `web-terminal-server/` + `web-terminal-linux.zip`)

### Full Tech Stack & Why `.exe` and `.deb` Packages Are Built This Way
- **Backend Stack**: Go 1.24 (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"` for static Linux binaries; Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation `rtx5_guard.dll` for Windows 64-bit `.exe` apps), PostgreSQL 16 (pipelined `pgx v5.9.0 SendBatch` + Async WAL + idempotent `broker-schema-compat.sql`), 256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`), and local-only (`127.0.0.1`) Redis/NATS buses.
- **Frontend Stack**: React 19 + TypeScript + Vite (`tsc -b && vite build --mode desktop`) + Lightweight Charts + Zustand (`O(1)` reference checks + `requestAnimationFrame` coalescing), embedded via Go `embed.FS` inside `RTX5-Terminal64.exe` and `rtx5-web-terminal-server` (`https://tcp-terminal.orrnn.com`).
- **Why `.exe` & `.deb` Are Built This Way**: Eliminates browser extension interference (`--disable-extensions` + isolated `%LOCALAPPDATA%\RTX5-Desktop-Profiles\terminal`), eliminates public HTTP/WebSocket latency and attack surfaces, enforces hardware-locked DPAPI/HWID session binding, provides 1-file portable Windows distribution (`1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader`), and provides 1-command Ubuntu 24.04 Linux VPS installation (`rtx5-superadmin`, `rtx5-broker`, `rtx5-web-terminal` under `/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`).

---

## 2. Mandatory Guardrails

1. **CI/CD Lock**: **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**
2. **Pure Binary TCP Transport**:
   - Never replace `/__rtx5_binary_order_ws` (132-byte binary order frame -> `:4443` / `:8190` 256-Shard RAM + WAL Engine in `< 0.5 ms`), `/__rtx5_binary_stream` (`0x21` ticks, `0x22` candles, `0x3A` private account/position/order/deal push events), `/__rtx5_binary_account_sub` (`0x3B`), `binaryTcpOrderClient.ts`, `binaryTcpMarketStream.ts`, or `/api/tcp-client/*` loopback bridges with legacy cloud WebSockets.
3. **Zero Hardcoded Brokers or Versions**:
   - Never hardcode broker names (`FXTrust`, `RTX5-Demo`) or versions (`v1.0.3`, `v1.0.0`).
   - Always use dynamic `.srv` broker discovery (`:9100` -> `:4443`, live broker `yo4x` on `185.126.217.108:4443`) and dynamic `VITE_APP_VERSION` / `package.json` version (`v2.2.4`).
4. **Immutable Security DLL**:
   - Never modify or recompile `rtx5_guard.dll`.
5. **Wire Protocol (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)**:
   - Encryption: `X25519 ECDH` + `HKDF-SHA256` + `AES-256-GCM`, 64-bit sequence numbers, 32-byte CSPRNG challenge-response nonces, `TCP_NODELAY`, Peer-IP lock, HWID/DPAPI lock, 60s Ed25519 `ExecutionLease` (`MaxEncryptedFrameBytes = 32 MB`).
   - Binary Frames: `0x21` (48B `BinaryTick`), `0x22` (72B wire / 64B stream `BinaryCandle`), `0x38` (128B/132B `FrameBinaryOrderFastReq`), `0x39` (136B/140B `FrameBinaryOrderFastResp`), `0x3A/0x3B` (`FrameBinaryTradeEvent` / `FrameBinaryAccountSub`), `0x34–0x37` (Binary OTA), and `127.0.0.1:8190` (`RTO\x01`/`RTO\x02` 32-socket raw order pool).
6. **Provisioning, `broker.lic`, & `:9100` OTA Auto-Push**:
   - Brokers are registered in `RTX5-SuperAdmin64.exe` (`yo4x`, `185.126.217.108:4443`), licensed via Ed25519-signed `/opt/rtx5-broker/config/broker.lic`, and updated via `publish-ota-release.ps1 -Channel all -Version "2.2.4"` over `:9100` (`POST /api/tcp-security/ota/upload`).
7. **Mandatory Post-Change Stress Testing**:
   - Run `cmd/sandbox_flood_crash_stress`, `cmd/verify_sub05ms_calc_sync`, `cmd/verify_ota_and_versions`, `bench_concurrent_live.exe`, `sim_binary_wire_saturation.exe`, and `sim_100m_traders.exe` after every change to verify `< 0.5 ms` execution, exact MT5 math, and zero crashes/deadlocks under 1,000+ concurrent order floods.
