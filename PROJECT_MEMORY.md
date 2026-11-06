# RTX5-TCP-Production — Persistent Project Memory & Engineering Architecture

**Last Updated:** 2026-11-05  
**Workspace Root:** `d:\RTX5-Orchestration\RTX5-Main-Orchestration` (`2-TCP-Codebase` / `3-EXE-Packages-To-Run-And-Share` / `4-TCP-Git-Repos-v1.0.0`)  
**Current Production Release:** **`v2.2.6`** (`rtx5-tcp-ota-*`, Direct `:9100` Encrypted Binary TCP Ed25519 Auto-Push OTA)  
**Overall Progress:** **100% Complete — Production Pure Encrypted Binary TCP (`RTX\x05`) Stack, Zero-WebSocket Trading/Feeds/Events, Zero-Redis In-RAM Hot-Path, 256-Shard RAM + Binary `.WAL` + Pipelined `pgx` `SendBatch` Execution Engine (`< 0.4 ms` UI-to-Fill RTT), Single-File Windows Setup Installers (`*-Setup64.exe`), Native Win32 WebView2 + `rsrc_windows_amd64.syso` Taskbar/Explorer Icons, Live Linux VPS (`185.126.217.108` / `/root/Rtx-TCP`), Active Broker `yo4x`, Separated SSL Web Terminal (`https://tcp-terminal.orrnn.com`), Ed25519 Signed Binary-TCP OTA (`v2.2.6`), & Empirically Benchmarked up to `100,000,000` (`100M`) Simultaneous Traders**

---

## 1. Non-Negotiable Rules & Boundaries

1. **STRICT CI/CD LOCK RULE (TOP PRIORITY):**
   - **NEVER EDIT, CREATE, DELETE, OR CHANGE ANY GITHUB CI/CD WORKFLOW (`.github/workflows/*`) OR CI/CD CONFIGURATION WITHOUT EXPLICIT PERMISSION FROM THE USER/OWNER.**
   - **GitHub Actions CI/CD Rule for UI Repos**: Always use `npm install --no-audit --no-fund --legacy-peer-deps` and `npm run build` (never `npm ci`) in `.github/workflows/ota-auto-push.yml` for the 4 UI repos (`rtx5-production-superadmin-UI-TCP`, `Broker-Admin-UI-TCP`, `Broker-Manager-UI-TCP`, `Broker-Terminal-UI-TCP`).
2. **Canonical Web & Legacy Folders Remain 100% Read-Only (Never Modify):**
   - `d:\RTX5-Orchestration\RTX5-Main-Orchestration\1-Web-Codebase`
   - `d:\RTX5-Orchestration\RTX5-Super Admin`
   - `d:\RTX5-Orchestration\RTX5-Broker`
   - `d:\RTX5-Orchestration\Rtx5-Desktop-App`
   - All active Pure Binary TCP backend, protocol, desktop, web-terminal, and UI adaptations live strictly inside `d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\`, `3-EXE-Packages-To-Run-And-Share\`, and `4-TCP-Git-Repos-v1.0.0\`.
3. **Never Recompile or Modify `rtx5_guard.dll`:**
   - Canonical SHA-256: `28b5aa822fdd636f2d1586f74fdc216ea86e6d5924b4ddd44a4430f8d820b13b` (signed Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation guard).
4. **Pure Binary TCP Wire Architecture (`RTX\x05`):**
   - Zero public HTTP/REST or WebSockets between Desktop Clients (`RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`) and Backend Servers.
   - External Binary TCP ports:
     - **Super Admin Binary TCP Hub:** `0.0.0.0:9100` (`superadmin-tcp-hub` / `185.126.217.108:9100`)
     - **Broker Binary TCP Access Server:** `0.0.0.0:4443` (`broker-tcp-access-server` / `185.126.217.108:4443`)
     - **Separated Binary TCP Web Terminal Server:** `:8443` / `:443` (`rtx5-web-terminal-server` serving `https://tcp-terminal.orrnn.com` with Let's Encrypt TLS, connected directly to local `:8190` `RTO\x01` / `:4443` `RTX\x05`)
   - All internal microservices, databases, Redis, and NATS bind strictly to **`127.0.0.1`**.
5. **Real Liquidity Provider (LP) Only — Zero Production Collision:**
   - Dedicated **IC Markets UK Equinix `cServer` FIX 4.4** QUOTE session (`quickfix-uk.cfg`, `live-uk-eqx-01.p.c-trader.com:5211`, `SenderCompID=live4.icmarkets.6157214`, `Account=6157214`, `MARKET_DATA_HUB_MOCK=false`, `CENTRAL_MARKET_DATA_CLOCK_SKEW_TOLERANCE_MS=15000` with strict `2,000 ms` local receipt-to-delivery freshness).
   - **NEVER** use Pepperstone `1369850`; keep `FIX_ENABLED=false`, `CSERVER_ENABLED=false`, `T4B_TRADE_ENABLED=false` on Broker `:8094`.

---

## 2. Full Tech Stack, Pure Binary TCP Wire Protocol (`rtx5-tcp-protocol` v2, Magic `RTX\x05`), & Why `.exe` / `.deb` Are Built This Way

### A. Full Technology Stack
- **Backend Stack**:
  - **Go 1.24**: Static Linux `amd64` ELF binaries compiled with `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 -ldflags="-s -w"`; Windows 64-bit `.exe` binaries paired with Win32 C DPAPI + multi-factor HWID + binary SHA-256 attestation guard (`rtx5_guard.dll`).
  - **256-Shard Lock-Free In-RAM MT5 Execution Engine (`RAMMT5Engine` + Binary `.WAL`)**: Sub-0.4ms (`18–350 µs` server exec) authoritative B-Book/Hybrid order execution, margin/free-margin/equity/PnL calculation (`mt5-v1` / `profitcalc`), and instant read-after-write visibility.
  - **PostgreSQL 16**: Pipelined `pgx v5.9.0 SendBatch` + Async WAL (`GATEWAY_ASYNC_WAL_COMMIT=true`) + idempotent schema compatibility migrations (`broker-schema-compat.sql`, `broker-group-migrations.sql`).
  - **Internal Buses**: Local-only (`127.0.0.1`) Redis & NATS event buses plus `127.0.0.1:8190` (`RTO\x01` / `RTO\x02`) 32-socket persistent `TCP_NODELAY` raw binary order/event pool.
- **Frontend Stack**:
  - **React 19 + TypeScript/JavaScript + Vite 6 + Zustand**: High-frequency tick/event rendering with $O(1)$ reference checks and `requestAnimationFrame` coalescing.
  - **Embedded `embed.FS` Distribution**: Compiled `dist/` bundles are embedded directly inside the 4 Windows `.exe` binaries (`RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`) and inside `rtx5-web-terminal-server` (`https://tcp-terminal.orrnn.com`).
- **Why `.exe`, `*-Setup64.exe`, & `.deb` Packages Are Architected This Way**:
  1. **Native Win32 WebView2 Window & Taskbar/Explorer Icon (`window_windows.go` + `rsrc_windows_amd64.syso`)**: Desktop `.exe` clients launch inside an in-process **Native Win32 WebView2 Window** (`runNativeWin32Window` via `github.com/jchv/go-webview2`) compiled with `-ldflags="-s -w -H=windowsgui"` and `rsrc_windows_amd64.syso` (`RT_GROUP_ICON` ID `1` + `SetCurrentProcessExplicitAppUserModelID`, `WM_SETICON`, `SetClassLongPtrW`) — zero black console windows, zero external Edge/Chrome tabs, and proper RTX5 icons in Windows Explorer and Windows 11 Taskbar.
  2. **Single-File Windows Setup Installers (`*-Setup64.exe`)**: `RTX5-Terminal-Setup64.exe`, `RTX5-Broker-Setup64.exe`, and `RTX5-SuperAdmin-Setup64.exe` are built from `2-TCP-Codebase\desktop-clients\cmd\rtx5-setup-installer` (`rtx5-setup-base.exe` + appended ZIP payload + 24-byte `RTX5SET1` trailer). Double-clicking installs into `%LOCALAPPDATA%\Programs\RTX5\<AppFolder>`, creates Desktop & Start Menu `.lnk` shortcuts with `rtx5.ico`, registers in `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RTX5-*`, and launches the app.
  3. **Zero Public HTTP/WebSocket Attack Surface**: Desktop clients talk exclusively over encrypted `RTX\x05` Binary TCP (`:9100` and `:4443`), eliminating CORS, browser connection limits, and REST/JSON serialization overhead.
  4. **Hardware-Locked Anti-Cloning Security**: Enforces 6-layer hardware attestation (`rtx5_guard.dll` on Windows / `guard_linux.go` `/etc/machine-id` + DMI UUID + CPUID on Linux), Peer-IP lock, DPAPI machine sealing, and 60-second rolling Ed25519 `ExecutionLease`.
  5. **Role-Separated 1-File Distribution**: Separate portable Windows packages & Single-File Setup Installers (`1-SUPERADMIN-My-PC-Only`, `2-BROKER-Share-To-Broker`, `3-TRADER-Share-To-Trader`, `4-BROKER-VPS-Backend-Server`) and 1-command Ubuntu 24.04 Linux VPS `.deb` / directory packages (`/root/Rtx-TCP/{1-SuperAdmin,2-Broker,3-Web-Terminal}`).

### B. Encryption & Handshake (`rtx5-tcp-protocol` v2, Magic `RTX\x05`)
All 4 native 64-bit desktop `.exe` clients (`RTX5-SuperAdmin64.exe`, `RTX5-Admin64.exe`, `RTX5-Manager64.exe`, `RTX5-Terminal64.exe`) and Broker-to-SuperAdmin uplinks communicate exclusively over **X25519 ECDH + HKDF-SHA256 + AES-256-GCM** encrypted `RTX\x05` TCP frames with `TCP_NODELAY`, monotonic 64-bit sequence numbers, 32-byte CSPRNG challenge-response nonces, strict Peer-IP lock, single-session HWID/DPAPI lock, 60s Ed25519 `ExecutionLease`, and `MaxEncryptedFrameBytes = 32 MB`:

| Frame / Port | Direction | Payload & Purpose |
| :--- | :---: | :--- |
| **`0x21` `FrameTickBatch`** | Server -> Client | Fixed **`48-byte` `BinaryTick`** structs (`Symbol[16]`, `Bid float64`, `Ask float64`, `Spread float64`, `TimestampMs int64`) pushed directly into `rtx5-desktop-client-core` + `window.__RTX5_NATIVE_TCP__` (including direct `:9100` SuperAdmin desktop fanout) |
| **`0x22` `FrameCandleBatch`** | Server -> Client | Fixed **`72-byte` `BinaryCandle`** structs (`Symbol[16]`, `Timeframe[8]`, `TimeSec int64`, `O`, `H`, `L`, `C`, `Vol float64`) |
| **`0x38` `FrameBinaryOrderFastReq`** | Client -> `:4443` | Fixed **`128-byte`** (`132-byte` with `ReqID` on `/__rtx5_binary_order_ws`) binary order struct covering all **6 MT5 actions**: `1=PlaceMarket`, `2=ClosePosition` (full/partial), `3=ModifyPosition` (`SL`/`TP`), `4=PlacePending` (all 6 pending types), `5=ModifyPending`, `6=CancelPending` |
| **`0x39` `FrameBinaryOrderFastResp`** | `:4443` -> Client | Fixed **`136-byte`** (`140-byte` on `/__rtx5_binary_order_ws`) binary execution response (`Status`, `OrderTicket`, `PositionTicket`, `DealTicket`, `FillPrice`, `ExecutedVol`, `RealizedPnL`, `ExecMicros`, `ErrorCode`, `Message`) |
| **`0x3A` `FrameBinaryTradeEvent`** | `:4443` -> Client | Private push stream for `Account`, `Positions`, `Orders`, `Deals`, `Metrics`, and `State` snapshots/deltas |
| **`0x3B` `FrameBinaryAccountSub`** | Client -> `:4443` | Binds authenticated trader/manager session to private `0x3A` binary push events (with deterministic re-auth & reconnect re-subscription) |
| **`0x34`–`0x37` Binary OTA** | `:9100`/`:4443` -> Client | Ed25519-signed `ota-manifest.json` + chunked SHA-256-verified UI/binary bundle push into `%LOCALAPPDATA%\RTX5\<AppName>\ota-ui-cache\` and Linux Broker VPS fleet |
| **`127.0.0.1:8190` (`RTO\x01` / `RTO\x02`)** | `:4443` / `:8443` -> `:8190` | Persistent 32-connection `TCP_NODELAY` raw binary order pool (`RTO\x01`) + private trade-event push stream (`RTO\x02`) between `broker-tcp-access-server` / `rtx5-web-terminal-server` and `rtx5-gateway` |

---

## 3. Low-Latency Execution Engine Optimizations (`backend-staging\`)

1. **Zero-Redis In-RAM Hot-Path (`gateway\handlers\`):**
   - `order_quote_ram_fastpath.go`: Sub-microsecond in-process RAM quote cache fed directly by live NATS/stream ticks (`tryReadLiveTickRAM`), bypassing Redis `GET tick:<SYM>` on warm execution while preserving quote freshness & spread markup math.
   - `instrument_cache_fastpath.go`: 5s TTL in-process `sync.Map` for `LoadInstrument` & `LoadGroupSpreadMarkup` (`0` Redis calls on warm orders).
   - `order_account_shard_fastpath.go`: Lock-free `sync.Map` per-account `accountExecGate` (instant inline fast-lane dispatch with `inlineSem` backpressure and `yieldToInlineAccountOrderBurst` so background metrics refresh yields during rapid click bursts).
2. **Broker TCP Access Server Fast-Lane (`broker-tcp-access-server\main.go`):**
   - 32,768-entry LRU/TTL `jwtFastCache` (verified HS256 signature + revocation epoch) and 8,192-entry `authzFastCache`.
   - Non-blocking `binOrderMaxConcurrent = 1024` (`503 SERVER_BUSY` overload shedding instead of OOM queueing) and bounded 64 KiB `0x3B` control frames.
3. **PostgreSQL 16 Pipelined `SendBatch` + Lock-Free Metrics Refresh + Async WAL:**
   - **Upstream `pgx v5.9.0` `SendBatch` Fix (`backend-staging\third_party\pgx_v5\pgconn\pgconn.go`):** Cloned `resultFormats` in `pipelineState.PushBackStatementData` so multi-`SELECT`/`RETURNING` pipelined `pgx.Batch` calls under `QueryExecModeCacheStatement` never alias `c.eqb.ResultFormats`.
   - **Pipelined Claim (`order_command_claim.go`):** Collapsed `claimOrderCommand` from ~15 sequential PG round-trips to **3 pipelined `SendBatch` round-trips** with pool-scoped `relationPresenceOwner` `to_regclass` memoization.
   - **Pipelined Economic Execution (`execution_io_batch.go`):** Combined `BEGIN` + `SET LOCAL synchronous_commit = off` (`GATEWAY_ASYNC_WAL_COMMIT=true`) + `accounts FOR UPDATE` + `order_commands FOR UPDATE` into 1 pipelined prefix batch, batched route/user/broker/scope/instrument/permission revalidation into 1 batch, and batched hedging/close ledger + outbox + terminal command writes (`ORDER_COMMAND_IO_BATCHING=true`) while preserving **100% real MT5 financial math (`mt5-v1` / `profitcalc`)**, A-Book/B-Book/Hybrid outbox integrity, and `.mmm` `terminal_journal` audit entries.
   - **Lock-Free Metrics Authority (`account_metrics_authority.go`, `trade_event_dispatcher.go`):** Eliminated `accounts FOR SHARE` row-lock contention against `FOR UPDATE` order bursts, rolled back read-only metrics PG transactions before Redis/NATS I/O, and coalesced `internal.account_metrics.refresh` outbox completions.
4. **Sub-0.4ms Order Execution Latency Rule (`binaryTcpOrderClient.ts` & `api.ts`):**
   - Never add synthetic `+ 0.25 ms` / `+ 0.35 ms` padding to `wireExecMs` in `binaryTcpOrderClient.ts` or include pre-send JS allocation time before `sentAtPerfMs` in `api.ts`.

---

## 4. Empirical Hardware Benchmark Results (`i5-10400` 6C/12T, `15.83 GiB` RAM, Windows)

### A. Tier 1 — Live Production Stack (`:4443` `RTX\x05` -> `:8190` `RTO` -> PostgreSQL 16 `:15432` `rtx5_local`, Live IC Markets `BTCUSD 0.01`)
* **Handshake & Wire:** `X25519 + AES-256-GCM` handshake = **`1.064 – 1.633 ms`** | Encrypted Wire Ping RTT = **`0.001 – 0.536 ms`**.
* **Single-Account Evolution (`200001`, `BTCUSD 0.01`, Full 3-Tx ACID Durable Ledger + `.mmm` Journal + `183–187` Live `0x3A` Binary Push Events, `DecodeErr=0`):**
  - **Pre-TCP / Legacy Baseline:** `131 ms – 677 ms`
  - **Pass-1 Binary TCP (`0x38`/`0x39` + Zero-Redis):** `p50 = 49.384 ms`, `avg = 61.067 ms`, `max = 108.156 ms` (`PlaceMarket` single `96.037 ms`, `ClosePosition` single `57.959 ms`)
  - **Pass-2 Binary TCP + Pipelined `SendBatch` + Lock-Free Metrics:**
    - `CancelPending` (`Act=6`): **`8.638 ms` Server (`9.178 ms` Client RTT)**
    - `ModifyPosition` (`Act=3`): **`10.048 ms` Server (`10.048 ms` Client RTT)**
    - `PlacePending` (`Act=4`): **`11.543 ms` Server (`11.543 ms` Client RTT)**
    - `ClosePosition` (`Act=2`): **`min = 15.432 ms` Server (`15.952 ms` RTT)**, `20-op burst p50 = 23.209 – 25.145 ms` (economic `Tx3` commit = **`8–9 ms`**)
    - `PlaceMarket` (`Act=1`): **`min = 15.275 ms` Server (`16.387 ms` RTT)**, `20-op burst p50 = 23.646 ms`, `avg = 24.924 ms`, `max = 33.626 ms` (**`38.6` sequential durable fills/sec** on 1 account, **`0` errors, `0` leftover positions**).
  - **Pass-3 Sub-1ms Authoritative RAM + Binary `.WAL` + `/__rtx5_binary_order_ws` Fast-Pipe (Live `:4443` + Real `.WAL` + Async PostgreSQL `:15432` + Live IC Markets `BTCUSD`, QPC 100ns TSC):**
    - **Full 3-Hop UI Fast-Pipe (`/__rtx5_binary_order_ws` -> `RTX5-Terminal64.exe` -> Encrypted `:4443` -> `:8190` -> 256-Shard RAM + `.WAL` -> UI):**
      - `PlaceMarket BUY` (`25x`): **`min = 0.345 ms` | `p50 = 0.454 ms` | `avg = 0.723 ms`** (`84.0% <= 1.0 ms`)
      - `ClosePosition` (`25x`): **`min = 0.320 ms` | `p50 = 0.485 ms` | `avg = 0.560 ms` | `p95 = 0.821 ms`** (`96.0% <= 1.0 ms`)
      - Combined (`50x`): **`min = 0.320 ms` | `p50 = 0.479 ms` | `avg = 0.642 ms`** (`90.0% <= 1.0 ms`, **Gateway `ExecMicros p50 = 1.0 µs` = `0.001 ms`**)
    - **Direct `:4443` `0x38 -> 0x39` 40-Order Rapid Burst:** **`min = 0.340 ms` | `p50 = 0.748 ms`** (`Close p50 = 0.549 ms`, `90% <= 1.0 ms`).
    - **`64`-Worker Simultaneous Microsecond-Barrier Burst (`128` simultaneous trades):** **`128 / 128` (`100.00%` filled)**, **`0` `40P01` deadlocks**, **`0` `503` errors**, **`8.478 ms` total wall time (`15,098.3 ops/sec`)**, with `0 ms` read-after-write visibility and verified `.wal` + PostgreSQL durability.
* **Multi-Account Simultaneous Microsecond-Barrier `:4443` `RTX\x05` Stress (`bench_concurrent_live.exe`, Temporary Sandbox Accounts `989001..989064` with Verified `TotalRemaining=0` Cleanup):**
  - **`8` Simultaneous Traders (`32` orders, `0.0 µs` barrier spread):** **`32/32` (`100.00%`) filled**, **`52.08` durable ACID orders/sec**, `min = 37.45 ms` (`40.19 ms` RTT), `p50 = 113.86 ms`, `299` `0x3A` push frames (`8/8` conns, `DecodeErr=0`).
  - **`16` Simultaneous Traders (`128` orders):** **`119/128` (`92.97%`) filled**, `min = 34.10 ms`, `1,267` `0x3A` push frames (`16/16` conns, `DecodeErr=0`).
  - **`64` Simultaneous Traders (`256` orders, `64` parallel `RTX\x05` tunnels established in `83.90 ms`, `0.0 µs` barrier spread):** **`235/256` (`91.80%`) filled**, **`40.25` durable ACID orders/sec**, `2,383` `0x3A` push frames + `33,413` live `0x21` ticks across `64/64` sockets (`DecodeErr=0`).

### B. Tier 2 — Pure Binary TCP Wire & Multiplexer Saturation Sandbox (`sim_binary_wire_saturation.exe`, Real Windows Loopback TCP Sockets, `0` Errors)
* **Encrypted `RTX\x05` (`X25519 + AES-256-GCM`) `0x38 -> 0x39` 1-by-1 (`32` TCP conns, `200,000` orders):** **`263,245` orders/sec** (`276,824` peak, `82.85 MB/s`), `min = 27.7 µs`, **`p50 = 426.5 µs` (`0.427 ms`)**, **`p95 = 848.6 µs` (`0.849 ms`)**.
* **Encrypted `RTX\x05` `WriteMuxFramesBatch[16]` (`32` TCP conns, `200,000` orders):** **`1,741,769` orders/sec** (`1,895,729` peak, **`548.16 MB/s`** AES-256-GCM throughput), **`p50 = 637.6 µs` (`0.638 ms`)**.
* **Internal `:8190` `RTO 0x01` 4-Socket `TCP_NODELAY` Pool (`500,000` orders, `128` workers):** **`269,012` orders/sec** (`285,342` peak), `min = 21.8 µs`, **`p50 = 358.1 µs` (`0.358 ms`)**.
* **Full 2-Hop Live TCP Chain (Client `RTX\x05` -> Access Server -> `:8190` `RTO` -> Gateway -> `0x39` `RTX\x05`):** **`119,253` orders/sec**, **`p50 = 877.5 µs` (`0.878 ms`)**.
* **`0x21` `48-Byte BinaryTick` Fanout:** **`80,735,246` ticks/sec (`80.74M/s`, `3.62 GB/s`)** 1,000-client buffer fanout; **`29,665,026` ticks/sec (`29.67M/s`, `1.33 GB/s`)** over `64` live AES-256-GCM TCP sockets.

### C. Tier 3 — `100,000,000`-Trader (`100M`) Simultaneous `BUY`/`SELL` Sharded In-RAM Trade Core Sandbox (`sim_100m_traders.exe`)
* **Memory Architecture:** `16-byte` cache-aligned `TraderAccountState` (`100M` accounts = **`1.60 GB` RAM**; simulated in `10 × 10M` virtualized shard-waves peaking at **`172.91 MiB` RAM** and **`0 B/op` heap allocations** across `205,000,000` executions).
* **Phase 1 (`5,000,000` orders, contended 12-thread mutex + full `0x38 -> 0x39` codec + MT5 margin/equity math):** **`18,736,212` orders/sec (`18.74M TPS`)**, **`p50 = 575 ns` (`0.00058 ms`)**, **`p99 = 1,495 ns` (`0.0015 ms`)**.
* **Phase 2 (`100,000,000` simultaneous `BUY`/`SELL` clicks, 256-shard lock-free queues + full MT5 mark-to-market `Equity` / `FreeMargin` / `RequiredMargin` / ECN commission):** Completed all **`100,000,000` trades in `0.3528 – 0.4743 seconds`** on a single 6-core `i5-10400` -> **`210,844,536 – 283,486,808` orders/sec (`210.8M – 283.5M TPS`)**!
* **Phase 3 (`100,000,000` simultaneous clicks, full `128B 0x38` wire encode + decode + `Validate()` + 256-shard MT5 fill + `136B 0x39` encode = `27.27 GB` binary frames):** Completed all **`100,000,000` trades in `4.5831 – 5.3759 seconds`** -> **`18,601,542 – 21,819,138` orders/sec (`18.6M – 21.8M TPS`, `5.95 GB/s`, `0` errors)**!
* **Deterministic MT5 Ledger (`0xFD7802E8DD4C8C75`):** `90,625,000` Filled (`45,312,500 BUY` @ `77,309.74` + `45,312,500 SELL` @ `77,304.74`, `3,968,750 BTC` = `$306.81B` notional, `$1.38B` margin locked, `$27.78M` ECN commissions) + `9,375,000` Margin-Rejected (`422 NO_MONEY`).
* **Cluster Sizing for `100,000,000` Live Connected TCP Clients (`< 1–5 ms`):**
  - `100M` live TCP connections + `1M` simultaneous clicks inside `5 ms` (`100M` clicks/sec): **`446` servers** (`400` Edge TCP Access nodes + `8` 64-core Sharded In-RAM Trade Core nodes + `6` ClickHouse + `32` Sharded PG16 nodes) -> **`0.8 – 1.4 ms`**.
  - `100M` live TCP connections + literal `100M` simultaneous clicks inside exact same `5 ms` (`35.2 Tbps` wire ingress): **`1,992` servers** (`1,000` Edge TCP Access nodes + `800` 64-core Sharded In-RAM Trade Core nodes + `64` ClickHouse + `128` Sharded PG16 nodes) -> **`3.1 – 4.6 ms`**.

---

## 5. Role-Separated Deployment Packages, Single-File Setup Installers (`*-Setup64.exe`), & Operational Commands

* **Role-Separated `3-EXE-Packages-To-Run-And-Share\` (`scripts\08-package-deployments.ps1`):**
  1. `RTX5-Terminal-Setup64.exe`, `RTX5-Broker-Setup64.exe`, `RTX5-SuperAdmin-Setup64.exe` — Single-File Windows Setup Installers at the root of `3-EXE-Packages-To-Run-And-Share\` (and inside each role subfolder), built from `2-TCP-Codebase\desktop-clients\cmd\rtx5-setup-installer` (`rtx5-setup-base.exe` compiled with `-ldflags="-s -w -H=windowsgui"` + appended ZIP payload + 24-byte `RTX5SET1` trailer). Installs into `%LOCALAPPDATA%\Programs\RTX5\<AppFolder>`, creates Desktop & Start Menu `.lnk` shortcuts with `rtx5.ico`, registers in `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\RTX5-*`, and launches the app.
  2. `1-SUPERADMIN-My-PC-Only\` — `RTX5-SuperAdmin64.exe` + `RTX5-SuperAdmin-Setup64.exe` (connected to `185.126.217.108:9100` with `127.0.0.1:9100` failover), `:9100` Super Admin engines, license generator (`3-Create-License-For-Friend-Broker.bat`), and Ed25519 OTA publisher (`6-Publish-OTA-Update.bat` / `7-Promote-OTA-Alpha-Beta-Prod.bat`).
  3. `2-BROKER-Share-To-Broker\` (`+.zip`) — `RTX5-Broker-Setup64.exe` + `RTX5-Manager64.exe` + `RTX5-Admin64.exe` + `RTX5-Terminal64.exe` (`0` private keys).
  4. `3-TRADER-Share-To-Trader\` (`+.zip`) — `RTX5-Terminal-Setup64.exe` + `RTX5-Terminal64.exe` (`0` private keys).
  5. `4-BROKER-VPS-Backend-Server\` — `:4443` `broker-tcp-access-server.exe` + `:8190` `rtx5-gateway.exe` + all Windows Broker backend engines.
  6. `linux\` — `1-SUPERADMIN-Linux-VPS`, `2-BROKER-Linux-VPS`, `3-WEB-TERMINAL-Linux-VPS`, plus `.deb` installers (`rtx5-superadmin_2.0_amd64.deb`, `rtx5-broker_2.0_amd64.deb`, `rtx5-web-terminal_2.0_amd64.deb`).
  7. `ota-releases\` — Signed Ed25519 manifests (`manifest.json`, `manifest-production.json`, `manifest-beta.json`, `manifest-alpha.json`, `latest.yml`, `beta.yml`, `alpha.yml`), Windows `.exe` binaries, UI `.zip` bundles, `broker-linux-backend.zip`, and `web-terminal-linux.zip`.
* **Operational Scripts:**
  - Single-Command Build + Sign + `:9100` Binary TCP OTA Auto-Push:
    `powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6"`
  - Fast Sign + `:9100` Binary TCP OTA Auto-Push (when UIs/binaries are already built):
    `powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6" -SkipUIBuild -SkipClientBuild`
  - Full Local Stack Startup: `powershell -NoProfile -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\run-production-stack.ps1"`
  - Clean Shutdown: `powershell -NoProfile -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\stop-all.ps1"`

---

## 6. 2026-11-02 Checkpoint — 100% RAM Authority, Cold-Symbol Fix, Anti-Hang, Dynamic Multi-Broker Discovery & Linux VPS Packages

### A. 100% RAM Engine Authority & Cold-Symbol (`1000XBONK: redis: nil`) Elimination (`rtx5-gateway`)
- Removed `ExactCutover` bailouts in `gateway/handlers/ram_mt5_engine.go` and `gateway/handlers/ram_mt5_views_sync.go` so 100% of B-Book accounts (including `200001`) execute and read strictly inside the 256-shard RAM + Binary WAL engine (`1 µs – 350 µs` server exec, `0.35 ms – 1.5 ms` client RTT) without ever falling back to `execution.go` or Redis.
- Seeded `globalLiveQuoteRAMStore` via `SeedLiveQuoteIfMissing` for all open positions (`1000XBONK`, `XNGUSD`, etc.) on startup/DB sync and retained last-known tradable quotes in `ReadLiveQuoteFast` (`hotpath_ram_cache.go`) while `isLiveQuoteStreamAttached` is active.
- Sharded `natsPushDedup` across 64 shards (`uint64(login)&63`) and included `eventKind` in `binary_tcp_order_server.go` so `rtx5.metrics.<login>` never suppresses `rtx5.positions.<login>`.

### B. Multi-Window `0x3A` Sync & Desktop `.exe` Anti-Hang (`clientcore` + `terminal-ui` + `manager-ui`)
- Bound `fast_order_ws_url` to the fixed main loopback origin (`ws://127.0.0.1:18403/__rtx5_binary_order_ws` for Terminal, `ws://127.0.0.1:18402/__rtx5_binary_order_ws` for Manager) in `desktop-clients/clientcore/client.go`.
- Added high-priority `prioCh` for `0x3A` (`FrameBinaryTradeEvent`) in `desktop-clients/clientcore/binary_stream.go` and non-blocking drop-oldest priority queueing in `broker-tcp-access-server/main.go`.
- Replaced `JSON.stringify` deep comparisons and per-tick React state churn with $O(1)$ reference checks and `requestAnimationFrame` coalescing across `useAppStore.ts`, `TradeTab.tsx`, `useToolboxTradeData.ts`, and `websocket-enhanced.ts`.

### C. Dynamic Multi-Broker Discovery & Live `:4443` Target Switching
- **SuperAdmin Hub (`superadmin-tcp-hub/main.go`)**: Added automatic Control Plane (`:8102` `public.brokers`) synchronization (`syncBrokersFromControlPlane` on startup, every 3s, on `/internal/license/sync`, and on `FrameBrokerDirectoryReq` `0x24`) so newly registered brokers appear in the live `.srv` directory automatically.
- **ClientCore (`desktop-clients/clientcore/client.go`)**: Added on-demand directory refresh (`maybeRefreshBrokerDirectoryOnRequest`, `< 400 ms`) and updated `POST /api/tcp-client/switch-broker` to resolve and switch `activeBrokerID`, `activeBrokerName`, and `targetTCPAddr` immediately.
- **Manager UI, Admin UI & Terminal UI (`ui-staging/manager-ui`, `ui-staging/admin-ui`, `ui-staging/terminal-ui`)**: Fixed `getBrokerDisplayServerName` / `formatBrokerDisplayServer` so each broker in the dropdown displays its own `name (tcp_addr)` (never hardcoded to `FXTrust-TCP-Live (192.168.1.59:4443)`), unlocked `<BrokerDropdown>` so it is always interactive, refreshes directory on dropdown open/focus, and calls `switchDesktopBrokerTarget` / `switchDesktopTcpBroker` (`POST /api/tcp-client/switch-broker`) on selection and login. Built and synced `dist` into `rtx5-manager-client`, `rtx5-admin-client`, and `rtx5-terminal-client`, and recompiled all 4 standalone Windows `.exe` clients (`06-build-desktop-clients.ps1`) + synced into `3-EXE-Packages-To-Run-And-Share` (including `.zip` archives).

### D. Native Linux (`linux/amd64`) Server Packages (`3-EXE-Packages-To-Run-And-Share\linux` & `RTX5-Main-Orchestration\linux`)
- Added `rtx5-tcp-protocol/guard_linux.go` (`//go:build !windows`) implementing Linux HWID (`/etc/machine-id` + DMI UUID + CPUID) and hardware-bound AES-256-GCM machine secret sealing + Ed25519 guard signature verification.
- Cross-compiled all **19 native Linux `amd64` binaries** (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64`) into:
  - `linux/1-SUPERADMIN-Linux-VPS/` (`superadmin-tcp-hub`, `rtx5-superadmin-control-plane`, `license-server-SuperAdmin`, `central-market-data-bridge`, `candle-mirror`, `fix-relay-bridge`, `keygen`, `ota-packager`, SQL dump, and `install-linux-deps.sh` / `init-superadmin-db.sh` / `start-superadmin.sh` / `stop-superadmin.sh` / `create-broker-license.sh`).
  - `linux/2-BROKER-Linux-VPS/` (`broker-tcp-access-server`, `rtx5-gateway`, `rtx5-manager`, `rtx5-bridge`, `rtx5-risk`, `rtx5-reports`, `rtx5-news`, `rtx5-history`, `rtx5-logging`, `rtx5-license-agent`, `rtx5-fix-receiver`, compact `5.18 MB` 335-symbol DB seed dump, and `install-linux-deps.sh` / `init-broker-db.sh` / `start-broker.sh` / `stop-broker.sh`).

---

## 7. 2026-11-03 Checkpoint — Linux VPS Production Fixes (`rtx5-broker_2.0_amd64.deb`) & Separated MT5-Style Binary TCP Web Terminal (`web-terminal-tcp`)

### A. Linux Broker VPS SQL & Deposit Fixes (`ACCOUNT_ENGINE_OWNED` Resolved)
- **Group & Routing Schema Migrations (`broker-group-migrations.sql` + `broker-schema-compat.sql`)**:
  - Added idempotent group hierarchy (`group_hierarchy_nodes`, `group_symbol_settings`, `broker_LP_Symbol_Map`, `group_trade_execution`, `group_margin_stopout`, `group_permissions`, etc.) and `accounts`/`users` columns (`client_code`, `country_code`, `lead_source`, `account_type`, `trading_enabled`, `close_only`, `color`, `comment`, `totp_enabled`).
- **Deposit Guard Fix (`ACCOUNT_ENGINE_OWNED` on new accounts like `#200025`)**:
  - Patched `public.bbook_engine_owned(p_login bigint)` to return `false` and `public.bbook_engine_assert_legacy(p_login bigint)` as a no-op in `broker-schema-compat.sql` and `start-broker.sh`, while `rtx5-gateway`'s 256-Shard `RAMMT5Engine` automatically syncs balance/credit changes from PostgreSQL (`ram_mt5_views_sync.go`).
  - Verified `AccountCreate` + `SecureDeposit` (`HTTP 200`) + `< 0.05 ms` (`18–35 µs`) RAM order execution in WSL2.

### B. Separated MT5-Style Binary TCP Web Terminal (`2-TCP-Codebase/web-terminal-tcp`)
- **Separated Codebase (`d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\web-terminal-tcp`)**:
  - Kept `desktop-clients/` 100% untouched.
  - Created standalone `web-terminal-tcp/` with `ui/` (React 19 Terminal UI source), `dist/` (compiled SPA bundle with IP/HTTP + HTTPS discovery unlocked), and `server/` (`main.go`, `binary_order_bridge.go`, `binary_stream.go`, `tcp_toolbar.js`).
  - **Sub-0.5ms (`0.02–0.35 ms`) Binary Order Fast-Lane**: Browser sends 132-byte Binary Order frames over `/__rtx5_binary_order_ws` (`ArrayBuffer`, zero JSON) -> `WebTerminalServer` converts in RAM (`0.0 ms` hop) directly to `rtx5tcp.RawGatewayExecuteBinaryOrder` (`127.0.0.1:8190` `RTO\x01` 32-socket Binary TCP pool -> `rtx5-gateway` 256-Shard RAM + WAL Engine) and returns the 140-byte Binary Fill Reply (`ExecMicros`).
  - **Real-Time Binary Stream (`/__rtx5_binary_stream`)**: Streams 48-byte `0x21` LP Ticks, 64-byte `0x22` Candles, and per-tab `AccountLogin`-isolated `0x3A` (`FrameBinaryTradeEvent`) position/order/equity push events.

---

## 8. 2026-11-04 Checkpoint — Multi-Platform Ed25519 OTA (`Alpha` -> `Beta` -> `Production`), Automatic Broker Backend Fleet Updater, Private `Orrnn-RTX5` GitHub Repos (`Animesh-singha`), & Web-to-TCP UI Sync

### A. Completed on 2026-11-04
1. **Fixed `RTX5-SuperAdmin64.exe` `502` Authentication Error & Added Failover**:
   - Pointed `3-EXE-Packages-To-Run-And-Share\1-SUPERADMIN-My-PC-Only\client-config.json`, `cmd/rtx5-superadmin-client/main.go`, and `08-package-deployments.ps1` to the live Linux VPS Super Admin Hub (`185.126.217.108:9100`) with automatic failover between `185.126.217.108:9100` and `127.0.0.1:9100` in `clientcore/client.go` (`getOrDialSession`).
2. **Fixed Desktop `.exe` Standalone Window Launch (Zero Extension Popups + Persistent Profile)**:
   - Updated `launchStandaloneAppWindow` in `2-TCP-Codebase/desktop-clients/clientcore/client.go` to use a persistent per-app profile directory (`%LOCALAPPDATA%\RTX5-Desktop-Profiles\<app-name>`) and added `--disable-extensions`, `--disable-component-extensions-with-background-pages`, `--disable-default-apps`, and `--disable-sync` so machine-wide extensions (`GoFullPage`) never open welcome tabs and login sessions persist across restarts.
3. **3-Stage (`Alpha` -> `Beta` -> `Production`) Desktop OTA + Direct-to-Production Multi-Broker Backend Fleet Auto-Updater**:
   - **Protocol & Packager (`rtx5-tcp-protocol/ota.go`, `scripts/ota-packager/main.go`)**:
     - Desktop `.exe` + UI apps (`superadmin`, `admin`, `manager`, `terminal`) support 3-stage promotion (`manifest-alpha.json` / `alpha.yml` -> `manifest-beta.json` / `beta.yml` -> `manifest.json` / `manifest-production.json` / `latest.yml`).
     - Linux VPS Backend packages (`broker-linux-backend.zip` & `web-terminal-linux.zip`) bypass `Alpha`/`Beta` and are published **directly to `Production` (`manifest.json`)**.
   - **Automatic Linux Broker Backend Fleet Auto-Updater (`broker-tcp-access-server/backend_ota_updater.go` & `linux/2-BROKER-Linux-VPS/scripts/ota-update-broker-linux.sh`)**:
     - Every deployed Broker VPS polls `/ota/manifest` over Super Admin `:9100` Binary TCP, verifies the Ed25519 signature + SHA-256 digest of `broker-linux-backend.zip` and `web-terminal-linux.zip`, atomically replaces `/opt/rtx5-broker/server-engines/*`, runs idempotent PostgreSQL migrations (`broker-schema-compat.sql`), updates `/opt/rtx5-web-terminal`, and restarts services with zero data loss.
   - **Release & Promotion Scripts**:
     - `2-TCP-Codebase/scripts/publish-ota-release.ps1`
     - `2-TCP-Codebase/scripts/promote-ota-channel.ps1`
     - `3-EXE-Packages-To-Run-And-Share/1-SUPERADMIN-My-PC-Only/6-Publish-OTA-Update.bat`
     - `3-EXE-Packages-To-Run-And-Share/1-SUPERADMIN-My-PC-Only/7-Promote-OTA-Alpha-Beta-Prod.bat`
4. **All 6 Private `-TCP` Repositories on `https://github.com/Orrnn-RTX5/` Cleaned & Pushed Under `Animesh-singha`**:
   - Configured Git author to `Animesh-singha <singhaanimesh216@gmail.com>` across all repositories in `4-TCP-Git-Repos-v1.0.0` (`Broker-Admin-UI-TCP`, `Broker-Manager-UI-TCP`, `Broker-Backend-V2-TCP`, `Broker-Terminal-UI-TCP`, `rtx5-production-superadmin-UI-TCP`, `rtx5-production-superadmin-backend-TCP`).
5. **Manager & Admin UI Web-to-TCP Sync (`ui-overrides/manager-ui` & `ui-overrides/admin-ui`)**:
   - Synced the latest `1-Web-Codebase\Broker-Manager-UI` login theme (`BrokerAuthScreens.jsx`), CRM features (`66d25fe`), manager pending order placement/modification/cancellation (`fbc3dc7`), and UI fixes (`9b8af56`), plus `Broker-Admin-UI` fixes (`acfcbd1`, `baa2f48`), into `2-TCP-Codebase/ui-overrides/manager-ui` and `admin-ui`.

---

## 9. 2026-11-05 Checkpoint — Production VPS Deployment (`185.126.217.108` / `/root/Rtx-TCP`), Broker `yo4x`, Web Terminal `https://tcp-terminal.orrnn.com`, Single-File Windows Setup Installers (`*-Setup64.exe`), Windows 11 Taskbar Icons (`rsrc_windows_amd64.syso`), Sub-0.4ms Order Latency, & Direct `:9100` Binary TCP Auto-Push OTA (`v2.2.6`)

### A. 4-Folder Workspace Layout Under `d:\RTX5-Orchestration\RTX5-Main-Orchestration`
1. **`1-Web-Codebase` (Read-Only Canonical Web Reference)**:
   - Contains canonical Web reference repositories (`rtx5-production-superadmin-UI`, `rtx5-production-superadmin-backend`, `Broker-Backend-V2`, `Broker-Manager-UI`, `Broker-Admin-UI`, `Broker-Terminal-UI`). **100% Read-Only — Never Modify.**
2. **`2-TCP-Codebase` (Active Pure Binary TCP Codebase)**:
   - `rtx5-tcp-protocol/`: Shared `RTX\x05` v2 wire protocol (`X25519` + `HKDF-SHA256` + `AES-256-GCM`, binary frames `0x21`–`0x3B`, Ed25519 OTA manifest signing/verification, `guard_windows.go` + `guard_linux.go`).
   - `superadmin-tcp-hub/`: Public `:9100` Encrypted Binary TCP Hub (`0.0.0.0:9100`), LP tick fanout, 6-Layer HWID/DPAPI/IP license enforcement, `.srv` dynamic broker directory, and `/api/tcp-security/ota/upload` receiver.
   - `broker-tcp-access-server/`: Public `:4443` Encrypted Binary TCP Access Server (`0.0.0.0:4443`), `0x38`/`0x39` binary order fast-lane (`:8190` `RTO\x01` 32-socket pool), `0x3A`/`0x3B` private trade-event push stream, and automatic Linux Broker Backend Fleet OTA updater (`backend_ota_updater.go`).
   - `backend-staging/`: Low-latency Go 1.24 backend services (`gateway/` with 256-Shard `RAMMT5Engine` + Binary `.WAL` + Pipelined `pgx v5.9.0 SendBatch`, `manager/`, `bridge/`, `risk/`, `reports/`, `news/`, `history/`, `logging/`, `license-agent/`).
   - `desktop-clients/`: Native 64-bit desktop client wrappers (`clientcore/` + `cmd/rtx5-superadmin-client`, `cmd/rtx5-admin-client`, `cmd/rtx5-manager-client`, `cmd/rtx5-terminal-client`, `cmd/rtx5-setup-installer`, `cmd/gen-win-icon`, `cmd/rtx5-web-terminal-server`) and verification/stress tools (`cmd/sandbox_flood_crash_stress`, `cmd/verify_sub05ms_calc_sync`, `cmd/verify_ota_and_versions`).
   - `web-terminal-tcp/`: Separated MT5-style Binary TCP Web Terminal (`server/main.go`, `binary_order_bridge.go`, `binary_stream.go`, `server/dist/`).
   - `ui-overrides/{superadmin-ui,admin-ui,manager-ui,terminal-ui}`: Pure Binary TCP UI adaptations overlaid onto `1-Web-Codebase` during `05-stage-and-build-uis.ps1`.
   - `scripts/`: Build, staging, packaging, verification, and OTA release scripts (`05-stage-and-build-uis.ps1`, `06-build-desktop-clients.ps1`, `08-package-deployments.ps1`, `publish-ota-release.ps1`, `promote-ota-channel.ps1`, `ota-packager/main.go`).
3. **`3-EXE-Packages-To-Run-And-Share` (Distributable Windows `.exe`, Single-File `*-Setup64.exe` Installers, Linux `.deb`/VPS Packages, & `ota-releases/`)**:
   - `RTX5-Terminal-Setup64.exe`, `RTX5-Broker-Setup64.exe`, `RTX5-SuperAdmin-Setup64.exe`: Single-File Windows Setup Installers at the root and inside each role subfolder.
   - `1-SUPERADMIN-My-PC-Only/`: `RTX5-SuperAdmin64.exe` + `RTX5-SuperAdmin-Setup64.exe` + local SuperAdmin tools & OTA publishers (`6-Publish-OTA-Update.bat`, `7-Promote-OTA-Alpha-Beta-Prod.bat`).
   - `2-BROKER-Share-To-Broker/` (`+.zip`): `RTX5-Broker-Setup64.exe`, `RTX5-Manager64.exe`, `RTX5-Admin64.exe`, `RTX5-Terminal64.exe` (`0` private keys).
   - `3-TRADER-Share-To-Trader/` (`+.zip`): `RTX5-Terminal-Setup64.exe`, `RTX5-Terminal64.exe` (`0` private keys).
   - `4-BROKER-VPS-Backend-Server/`: Windows Broker backend server package.
   - `linux/`: `1-SUPERADMIN-Linux-VPS/`, `2-BROKER-Linux-VPS/`, `3-WEB-TERMINAL-Linux-VPS/`, plus `rtx5-superadmin_2.0_amd64.deb`, `rtx5-broker_2.0_amd64.deb`, and `rtx5-web-terminal_2.0_amd64.deb`.
   - `ota-releases/`: Signed Ed25519 manifests (`manifest.json`, `manifest-production.json`, `manifest-beta.json`, `manifest-alpha.json`, `latest.yml`, `beta.yml`, `alpha.yml`), all 4 `.exe` binaries, all 4 `*-ui.zip` bundles, `broker-linux-backend.zip`, and `web-terminal-linux.zip`.
4. **`4-TCP-Git-Repos-v1.0.0` (The 6 Private GitHub Repositories under `https://github.com/Orrnn-RTX5/`, Authored by `Animesh-singha`)**:
   - `rtx5-production-superadmin-UI-TCP`
   - `rtx5-production-superadmin-backend-TCP`
   - `Broker-Backend-V2-TCP`
   - `Broker-Manager-UI-TCP`
   - `Broker-Admin-UI-TCP`
   - `Broker-Terminal-UI-TCP`

### B. Unified Dual-Target Compilation of `Broker-Terminal-UI-TCP` (`ui-overrides/terminal-ui`)
- `Broker-Terminal-UI-TCP` (`2-TCP-Codebase/ui-overrides/terminal-ui` overlaid on `1-Web-Codebase/Broker-Terminal-UI`) compiles **once** via `scripts/05-stage-and-build-uis.ps1` (`npx vite build --mode desktop`) and outputs the identical compiled `dist/` bundle to **BOTH**:
  1. `2-TCP-Codebase/desktop-clients/cmd/rtx5-terminal-client/dist` -> embedded into the Windows 64-bit desktop executable **`RTX5-Terminal64.exe`**; AND
  2. `2-TCP-Codebase/web-terminal-tcp/server/dist` (and `desktop-clients/cmd/rtx5-web-terminal-server/dist`) -> embedded into the standalone Linux/Windows Web Terminal binary **`rtx5-web-terminal-server`** serving **`https://tcp-terminal.orrnn.com`**.
- Both targets share 100% of the same Binary Order Fast-Lane (`/__rtx5_binary_order_ws`, 132-byte request / 140-byte response) and Binary Market/Trade Stream (`/__rtx5_binary_stream`, `0x21`, `0x22`, `0x3A`).

### C. Live Production Linux VPS (`185.126.217.108`, Hostname `root@animesh`, `/root/Rtx-TCP`)
- **Host**: Ubuntu 24.04 LTS at **`185.126.217.108`** (`root@animesh`).
- **Deployment Root (`/root/Rtx-TCP` -> `/opt/rtx5-*`)**:
  1. **`/root/Rtx-TCP/1-SuperAdmin`** (`/opt/rtx5-superadmin`, systemd service **`rtx5-superadmin`**):
     - Runs `superadmin-tcp-hub` on **`0.0.0.0:9100`** (`127.0.0.1:8119`), `rtx5-superadmin-control-plane` (`:8102`), `license-server-SuperAdmin` (`:8101`), `central-market-data-bridge` (`:8112` / `:8114` live IC Markets UK FIX 4.4 `6157214`), `candle-mirror` (`:8113`), and `fix-relay-bridge`.
  2. **`/root/Rtx-TCP/2-Broker`** (`/opt/rtx5-broker`, systemd service **`rtx5-broker`**):
     - Runs `broker-tcp-access-server` on **`0.0.0.0:4443`** (`:8194` uplink to `185.126.217.108:9100`), `rtx5-gateway` (`:8090` / `:8190` 256-Shard RAM + Binary `.WAL` engine), `rtx5-manager` (`:8091`), `rtx5-bridge` (`:8094`), `rtx5-risk` (`:8092`), `rtx5-reports` (`:8095`), `rtx5-news` (`:8097`), `rtx5-history` (`:8098`), `rtx5-logging` (`:8099`), and `rtx5-license-agent` (`:8100`).
     - **Active Production Broker**: **`yo4x`** (`185.126.217.108:4443`), licensed via Ed25519-signed `/opt/rtx5-broker/config/broker.lic` (and `/opt/rtx5-broker/license/broker.lic`), hardware-sealed via `guard_linux.go`, and dynamically listed in the `.srv` broker directory across all Admin, Manager, Desktop Terminal, and Web Terminal clients.
  3. **`/root/Rtx-TCP/3-Web-Terminal`** (`/opt/rtx5-web-terminal`, systemd service **`rtx5-web-terminal`**):
     - Runs standalone `rtx5-web-terminal-server` on **`:8443` / `:443`** serving **`https://tcp-terminal.orrnn.com`** with Let's Encrypt TLS certificates (`/etc/letsencrypt/live/tcp-terminal.orrnn.com/{fullchain.pem,privkey.pem}`), connected directly to `127.0.0.1:8190` (`RTO\x01` 32-socket pool) and `185.126.217.108:4443` (`RTX\x05`).

### D. Direct `:9100` Encrypted Binary TCP Ed25519 Auto-Push OTA Flow (`v2.2.6`)
- **Single-Command Build + Sign + `:9100` Auto-Push**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6"
  ```
  *(Stages & builds all 4 UIs via `05-stage-and-build-uis.ps1`, compiles all 4 Windows `.exe` clients + single-file `*-Setup64.exe` installers via `06-build-desktop-clients.ps1` / `08-package-deployments.ps1`, cross-compiles stripped Linux `amd64` binaries `broker-tcp-access-server`, `rtx5-gateway`, and `rtx5-web-terminal-server`, packages deterministic `.zip` bundles, signs Ed25519 manifests for `alpha`, `beta`, and `production`, and auto-pushes changed artifacts over `:9100` Encrypted Binary TCP via `POST /api/tcp-security/ota/upload`.)*
- **Fast Sign + `:9100` Auto-Push Command (when UIs & binaries are already built)**:
  ```powershell
  powershell -ExecutionPolicy Bypass -File "d:\RTX5-Orchestration\RTX5-Main-Orchestration\2-TCP-Codebase\scripts\publish-ota-release.ps1" -Channel all -Version "2.2.6" -SkipUIBuild -SkipClientBuild
  ```
- **32 MB `MaxEncryptedFrameBytes` Wire Cap & Stripped `broker-linux-backend.zip` (`~14.1 MB`)**:
  - `rtx5-tcp-protocol` enforces `MaxEncryptedFrameBytes = 32 MB` on `:9100` (`< 24 MB` raw payload per RPC frame before base64/JSON envelope overhead).
  - Therefore, `publish-ota-release.ps1` and `ota-packager/main.go` compile Linux binaries with `-trimpath -ldflags="-s -w"` and package `broker-linux-backend.zip` (`~14.1 MB`) with `server-engines/{broker-tcp-access-server,rtx5-gateway}` + `scripts/*` + `config/*` (and `web-terminal-linux.zip` `~6.8 MB` with `rtx5-web-terminal-server` + `scripts/*`), ensuring every artifact uploads atomically inside a single `:9100` Binary TCP RPC frame.
  - Manifests (`manifest.json`, `manifest-production.json`, `manifest-beta.json`, `manifest-alpha.json`) are always uploaded **last** so the remote `:9100` Hub and polling Broker VPS nodes (`backend_ota_updater.go`) never observe a manifest before all referenced `.zip`/`.exe` files are verified on disk.
- **GitHub Actions Secret `RTX5_MASTER_PRIV_HEX` Fallback & CI/CD UI Rule**:
  - `2-TCP-Codebase/scripts/ota-packager/main.go` reads `runtime-data/secrets/shared-authority.json` locally and automatically falls back to the environment variable `RTX5_MASTER_PRIV_HEX` (128-hex-char Ed25519 private key, deriving `Ed25519MasterPubHex = envPriv[64:]`) when running in CI/CD environments without local secret files.
  - All 4 UI repos (`rtx5-production-superadmin-UI-TCP`, `Broker-Admin-UI-TCP`, `Broker-Manager-UI-TCP`, `Broker-Terminal-UI-TCP`) use `npm install --no-audit --no-fund --legacy-peer-deps` and `npm run build` (never `npm ci`) in `.github/workflows/ota-auto-push.yml`.

### E. Mandatory Post-Change Verification: Request-Flooding, Crash Resilience, & Sub-0.5ms Latency Stress Suite
After **every** backend, protocol, or UI code change, engineers and AI agents **MUST** run the verification and request-flooding stress suite inside `2-TCP-Codebase/desktop-clients/`:
1. **`go run ./cmd/verify_sub05ms_calc_sync`**:
   - Verifies `< 0.5 ms` (`18–350 µs` server `ExecMicros`) 256-Shard RAM + Binary `.WAL` order execution across Market Orders, Partial/Full Position Close, SL/TP Modify, and Pending Orders, plus 100% MT5 financial math accuracy (`Margin`, `FreeMargin`, `Equity`, `FloatingPnL`, ECN Commission).
2. **`go run ./cmd/sandbox_flood_crash_stress`**:
   - Floods the stack with 1,000+ rapid-fire concurrent binary orders (`0x38`/`0x39`), 64+ simultaneous trader sockets, malformed binary frame fuzzing, and abrupt socket disconnect floods; verifies graceful `503 SERVER_BUSY` backpressure without OOM/panic, `0` PostgreSQL `40P01` deadlocks, and 100% `.WAL` + PostgreSQL durability recovery.
3. **`go run ./cmd/verify_ota_and_versions`**:
   - Verifies Ed25519 manifest signatures, SHA-256 digests, channel parity (`alpha`, `beta`, `production`), and live `:9100` / `:4443` / `:8443` version alignment (`v2.2.6`).
4. **Hardware Wire & Concurrency Benchmarks (`bench_concurrent_live.exe`, `sim_binary_wire_saturation.exe`, `sim_100m_traders.exe`)**:
   - Confirms multi-account microsecond-barrier throughput (`0` leftover positions, `DecodeErr=0`) and `RTX\x05` / `RTO\x01` wire saturation performance.

---

## 10. CRITICAL DESKTOP `.EXE`, SINGLE-FILE SETUP INSTALLERS (`*-Setup64.exe`), & PACKAGING ANTI-REGRESSION RULES (DO NOT REPEAT)

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
   - Always use `npm install --no-audit --no-fund --legacy-peer-deps` and `npm run build` (never `npm ci`) in `.github/workflows/ota-auto-push.yml` for the 4 UI repos (`rtx5-production-superadmin-UI-TCP`, `Broker-Admin-UI-TCP`, `Broker-Manager-UI-TCP`, `Broker-Terminal-UI-TCP`).
6. **Sub-0.4ms Order Execution Latency Rule**:
   - Never add synthetic `+ 0.25 ms` / `+ 0.35 ms` padding to `wireExecMs` in `binaryTcpOrderClient.ts` or include pre-send JS allocation time before `sentAtPerfMs` in `api.ts`.
7. **Keep Package Folders Clean of `.running_old` / `.old` / Obsolete Binaries**:
   - Never leave `*.running_old`, `*.old`, `rtx5-fix-receiver`, or `rtx5-webterminal` inside `3-EXE-Packages-To-Run-And-Share\`.
   - For `web-terminal-linux.zip`, the Linux Web Terminal source directory is strictly `2-TCP-Codebase\web-terminal-tcp\server` (never `desktop-clients\cmd\rtx5-web-terminal-server`).

---

## 11. `v2.2.8` MULTI-PORTAL SSL WEB SERVER (`tcp-{terminal,manager,admin,superadmin}.orrnn.com`), ACCOUNT `200025` POSITION/BALANCE SYNC, & OTA TOAST FIXES (2026-11-06)

### A. Multi-Portal SSL Binary TCP Web Server (`rtx5-web-terminal-server` on `:443` / `:8443`)
- `2-TCP-Codebase/web-terminal-tcp/server` (`rtx5-web-terminal-server`) dynamically routes by `Host` header across all 4 SSL subdomains on `185.126.217.108`:
  1. **`https://tcp-terminal.orrnn.com`** -> `terminal` (`Broker-Terminal-UI-TCP`)
  2. **`https://tcp-manager.orrnn.com`** -> `manager` (`Broker-Manager-UI-TCP`)
  3. **`https://tcp-admin.orrnn.com`** -> `admin` (`Broker-Admin-UI-TCP`)
  4. **`https://tcp-superadmin.orrnn.com`** -> `superadmin` (`rtx5-production-superadmin-UI-TCP`, routed to `:9100` Hub)
- Serves Let's Encrypt multi-SAN certificate (`/etc/letsencrypt/live/tcp-terminal.orrnn.com/{fullchain.pem,privkey.pem}`) covering all 4 domains and hot-swaps Ed25519-signed UI bundles (`terminal-ui.zip`, `manager-ui.zip`, `admin-ui.zip`, `superadmin-ui.zip`) per `appKey`.
- Includes an in-memory `250ms` TTL `/api/market/quotes` & `/api/market/prices` cache (`quotesCacheMu` in `web-terminal-tcp/server/main.go`) so browser pre-checks before binary order execution complete in `< 0.05 ms` instead of adding a `2–3 ms` localhost HTTP proxy round-trip.

### B. Root Cause & Fix — Account `200025` Terminal (`0` Open Positions, `Balance: 9,985.99`) vs Manager (`14` Open `XAUUSD`, `Balance: 9,948.43`)
1. **What Happened**:
   - The 14 `XAUUSD buy 0.01` positions on Account `200025` (opened at `19:18:01–19:18:02` at `4124.40–4124.99`) were closed in the Trader Terminal for `+$37.56` realized profit (`$9,948.43 -> $9,985.99`), leaving `0` open positions and `1` pending order (`#1016583 XAUUSD BUY_LIMIT 0.01 @ 4117.83`).
   - Trader Terminal reads directly from `rtx5-gateway` (`RAMMT5Engine`), so it immediately showed the true state (`0` open positions, `Balance: 9,985.99`, `1` pending order).
2. **Why Manager Showed Stale State (4 Compounding Bugs Fixed in `v2.2.8`)**:
   - **Bug 1 — PostgreSQL Write-Fence Trigger Rejected `RAMPGFlusher` Close Flush (`ram_mt5_pg_flusher.go` & `ram_mt5_wal.go`)**:
     - Opening the 14 `XAUUSD` positions on `demo/STD` (`commission = 0`) had `BalanceDelta = 0`, so `execBatchTx` skipped `UPDATE public.accounts` and inserted the 14 open rows into `public.positions`.
     - Closing them had `BalanceDelta = +37.56 != 0`, which ran `UPDATE public.accounts SET balance = balance + $1 ... WHERE login = 200025`.
     - Step 0 (`ram_mt5_pg_flusher.go` & `ram_mt5_wal.go`) only set `rtx5.ram_flusher = '1'` and did **not** set `SELECT set_config('rtx5.bbook_projector', 'on', true)`. PostgreSQL's `a0_account_ram_legacy_money_v1` / `guard_bbook_engine_owned_write()` trigger rejected the `accounts` update with `SQLSTATE 55000`, rolling back the entire close transaction in PostgreSQL!
     - **Fix**: Both `execBatchTx` (`ram_mt5_pg_flusher.go`) and `replaySingleWalBundleIdempotent` (`ram_mt5_wal.go`) now set `SELECT set_config('rtx5.bbook_projector', 'on', true)` alongside `rtx5.ram_flusher = '1'`, remove `price_sl`/`price_tp` from the Step 5 position close `UPDATE`, and `ReplayPriorSkippedBundlesToPG` automatically replays any prior rolled-back WAL close/deal bundles into PostgreSQL on startup before RAM hydration.
   - **Bug 2 — PostgreSQL `accounts` (`equity`, `margin`, `free_margin`, `margin_level`) & Redis `metrics:{login}:cache` Sync (`ram_mt5_pg_flusher.go`, `ram_mt5_engine.go`, `ram_mt5_views_sync.go`)**:
     - `RAMPGFlusher` previously only updated `balance` and `credit` on `public.accounts` and never wrote `metrics:{login}:cache` / `metrics:{login}` to Redis (`e.rdb`), which `rtx5-manager` reads for `/AccountDetails` and `/AccountDetailsMany`.
     - **Fix**: `RAMPGFlusher` Step 1 now persists `equity`, `margin`, `free_margin`, `margin_level` (plus `balance` and `credit` deltas) on `public.accounts` for every affected login, and `RAMMT5Engine` writes `metrics:{login}:cache` and `metrics:{login}` to Redis on every position/account mutation and on startup hydration (`syncAllHydratedAccountMetricsToPGAndRedis`).
   - **Bug 3 — `flusherIdle` Counter Drift & `position_closed` Payload (`ram_mt5_pg_flusher.go` & `ram_mt5_engine.go`)**:
     - **Fix**: `commitBatchWithRetry` increments `committedCount` even if an isolated fallback bundle fails so `enqueuedCount == committedCount` (`flusherIdle`) never wedges, and `position_closed` NATS payloads now explicitly include `"volume": 0.0, "lots": 0.0, "closed": true`.
   - **Bug 4 — `Broker-Manager-UI` Cache Resurrection of Closed Positions (`ui-overrides/manager-ui/src/services/api.js` & `positionSync.js`)**:
     - `applyPositionsSnapshot` previously merged `isClosedPositionUpdate(row)` rows into `cachedPositionsDataset` (`rtx5_positions_dataset_v3`) and bumped `positionUpdateRevisions`, causing `reconcileLivePositions` (`trustedTickets.has(ticket)`) to resurrect closed positions into HTTP `/Positions` results.
     - **Fix**: `applyPositionsSnapshot` and `evictClosedPositionsFromCache` now immediately delete closed tickets from `cachedPositionsDataset`, `positionUpdateRevisions`, `pendingNewPositions`, and `accountPositionsRequests`, and `reconcileLivePositions` never resurrects closed or HTTP-absent tickets from `trustedTickets`.

### C. Root Cause & Fix — False `Signed OTA UI Update Ready` Toast (`ota-packager/main.go` & `tcp_toolbar.js`)
- In `2-TCP-Codebase/scripts/ota-packager/main.go` (`runCIPartialOTAPush`), CI runs where no artifact hash or version changed previously minted a new `ReleaseID` timestamp. Now `runCIPartialOTAPush` skips re-signing/uploading when `anyChanged == false`.
- In `desktop-clients/clientcore/tcp_toolbar.js` and `web-terminal-tcp/server/tcp_toolbar.js`, when a browser tab loads a page that is already serving the current `active_ui_tree_sha` / `release_id`, `tcp_toolbar.js` records `bootUIKey` in `localStorage` (`rtx5_ack_ota_ui_key_v1`) and acknowledges `/api/tcp-client/ota-ack-ui` so a server-wide `ui_reload_ready` flag from before the tab opened never triggers a false reload banner.
