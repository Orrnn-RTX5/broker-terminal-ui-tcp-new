# Backend Implementation Prompt: Real-Time Cross-Device Chart Drawing Sync (PostgreSQL + `0x3A` Binary TCP Fanout)

> **Copy-paste this entire document to the Backend Team / Backend Coding Agent (`Broker-Backend-V2-TCP` / `rtx5-gateway` + `broker-tcp-access-server` + `rtx5-tcp-protocol`).**

---

## 1. Goal (What We Need)

Make **chart drawing tools** (trendlines, horizontal/vertical lines, rectangles, channels, Fibonacci, text/annotations, position tools, etc., plus Hide/Show visibility) synchronize **live in real time across every device/system logged into the same broker account** — **with zero page refresh / hard refresh** — working **identically to how live trades/positions already sync**.

Specifically, when Account `200010` on Broker `orrnn` is logged in on:
- **System A** (e.g., Deployed Web Terminal `https://tcp-terminal.orrnn.com`, OR Local Dev `http://127.0.0.1:5173`, OR Desktop `.exe` / `.dmg` / `.deb`)
- **System B** (any other laptop/PC/browser/desktop app logged into the **same broker + same account**, viewing the **same symbol**)

When System A creates, drags/edits, locks, deletes, clears, or hides/shows a drawing on `EURUSD`:
1. The drawing is persisted centrally in **PostgreSQL 16** (so reloads, new logins, and new devices always get the authoritative state).
2. The change is pushed **live in real time** over the existing **NATS / `:8190` `RTO\x01` / `:4443` `RTX\x05` `0x3A` (`FrameBinaryTradeEvent`)** pipeline (and `/ws/v2` for legacy WebSocket clients).
3. **System B sees the drawing immediately without refreshing.**
4. Different accounts (e.g., `200010` vs `200011`) and different brokers remain **100% isolated**.

---

## 2. Why It Does NOT Work Today (Root Cause)

1. **Trades** go from any client -> `:4443` Binary TCP -> **`rtx5-gateway`** (`:8090`) -> **PostgreSQL 16** + **NATS / `:8190` `RTO\x01`** -> **`broker-tcp-access-server` (`:4443`)** pushes **`0x3A` (`FrameBinaryTradeEvent`)** to **every open client tunnel** subscribed via `0x3B` (`FrameBinaryAccountSub`) for that `account_login`.
2. **Drawings** currently have **no central PostgreSQL persistence and no `0x3A` push** in `rtx5-gateway` / `broker-tcp-access-server`:
   - The UI repo temporarily added `web-terminal-server/drawings_sync.go`, which intercepts `/api/fix/drawings` and `/__rtx5_drawing_ws` **locally inside a single `web-terminal-server` process** and writes JSON files to **local disk** (`runtime-data/drawings/<broker>/<login>.json`).
   - Because each system/bridge has its own isolated local process & disk, drawings created on one system never reach another system, local dev never syncs with deployed `https://tcp-terminal.orrnn.com`, Desktop clients (`.exe`/`.dmg`/`.deb`) don't have `/__rtx5_drawing_ws` at all, and UI-only OTA pushes (`dist/`) don't even update the deployed `rtx5-web-terminal-server` binary.
   - Furthermore, `/api/fix/drawings` currently falls through `classifyBrokerRoute` to `rtx5-manager` (`:8091`) on Desktop clients and on deployed `rtx5-web-terminal-server`, whereas **`/api/v2/*` ALREADY routes directly to `rtx5-gateway` (`:8090`) across EVERY web and desktop binary!**

---

## 3. Architecture Design (Reuse Existing Trade-Sync Plumbing)

Do **not** open new public ports and do **not** require a new WebSocket route on Nginx/Cloudflare or `desktop-clients`. Reuse the exact two channels that already work everywhere:

1. **HTTP CRUD & Initial Load**: Expose `/api/v2/drawings*` on **`rtx5-gateway` (`:8090`)** backed by **PostgreSQL 16**.
   - Every existing `rtx5-web-terminal-server` and `desktop-clients` binary ALREADY routes `strings.HasPrefix(path, "/api/v2/")` to `"gateway"` (`rtx5-gateway`).
2. **Live Real-Time Push**: Reuse **`FrameBinaryTradeEvent` (`0x3A`)** over `:4443` / `:8190` (`RTO\x01`) + **NATS** + **`/ws/v2`**, using a new `EventKind` code:
   - `BinaryTradeEventDrawings uint8 = 7`
   - `Channel = "drawings.<account_login>"` (e.g., `"drawings.200010"`)
   - **Why this works immediately across ALL clients**:
     - Both Go (`rtx5-tcp-protocol.DecodeBinaryTradeEvent`, `web-terminal-server/binary_stream.go`, `desktop-clients/clientcore/binary_stream.go`) and JS (`binaryTcpMarketStream.ts:decodeBinaryTradeEvent`) already accept any `EventKind uint8` and forward `0x3A` frames strictly by `AccountLogin` (`payload[2:10]`) directly to `/__rtx5_binary_stream`!

### Non-Negotiable Performance Invariant
- **NEVER touch or block `RAMMT5Engine` order locks or the `0x38`/`0x39` binary order fast-lane.**
- Drawing persistence uses normal PostgreSQL queries on `rtx5-gateway` (completely separate from order execution) and non-blocking NATS / `0x3A` publish calls.

---

## 4. Step-by-Step Backend Implementation Tasks

### Step 1: PostgreSQL 16 Schema Migration (Idempotent)

Add the following idempotent migration to `broker-schema-compat.sql` (and run automatically on `rtx5-gateway` startup so existing broker VPS databases upgrade cleanly with zero manual steps):

```sql
-- 1. Strictly monotonic per-account revision counter for deterministic client sync
CREATE TABLE IF NOT EXISTS public.chart_drawing_revisions (
    broker_id      TEXT    NOT NULL,
    account_login  BIGINT  NOT NULL,
    revision       BIGINT  NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (broker_id, account_login)
);

-- 2. Authoritative chart drawings per (broker_id, account_login, drawing_id)
CREATE TABLE IF NOT EXISTS public.chart_drawings (
    broker_id          TEXT        NOT NULL,
    account_login      BIGINT      NOT NULL,
    drawing_id         TEXT        NOT NULL,
    client_drawing_id  TEXT        NOT NULL DEFAULT '',
    symbol             TEXT        NOT NULL,
    timeframe          TEXT        NOT NULL DEFAULT '',
    drawing_type       TEXT        NOT NULL,
    properties         JSONB       NOT NULL DEFAULT '{}'::jsonb,
    revision           BIGINT      NOT NULL DEFAULT 1,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (broker_id, account_login, drawing_id)
);

CREATE INDEX IF NOT EXISTS idx_chart_drawings_account_symbol
    ON public.chart_drawings (broker_id, account_login, symbol);

CREATE INDEX IF NOT EXISTS idx_chart_drawings_client_id
    ON public.chart_drawings (broker_id, account_login, client_drawing_id)
    WHERE client_drawing_id <> '';

-- 3. Shared Hide/Show drawings visibility state per account/scope
CREATE TABLE IF NOT EXISTS public.chart_drawing_visibility (
    broker_id        TEXT        NOT NULL,
    account_login    BIGINT      NOT NULL,
    scope_key        TEXT        NOT NULL, -- "*", "EURUSD::*", or "EURUSD::M1"
    drawings_hidden  BOOLEAN     NOT NULL DEFAULT FALSE,
    revision         BIGINT      NOT NULL DEFAULT 1,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (broker_id, account_login, scope_key)
);
```

**Atomic Revision Bump Helper (inside each write transaction):**
```sql
INSERT INTO public.chart_drawing_revisions (broker_id, account_login, revision, updated_at)
VALUES ($1, $2, 1, NOW())
ON CONFLICT (broker_id, account_login)
DO UPDATE SET revision = public.chart_drawing_revisions.revision + 1, updated_at = NOW()
RETURNING revision;
```

---

### Step 2: REST API Endpoints in `rtx5-gateway` (`:8090`)

Implement all 6 endpoints under `/api/v2/drawings` (and optionally alias `/api/fix/drawings` to the exact same handler):

#### Authentication & Tenant Isolation (Mandatory on EVERY Endpoint)
- Require a valid trader JWT in `Authorization: Bearer <token>`, verified with `rtx5-gateway`'s existing JWT signature + expiration middleware. Reject missing/invalid/expired tokens with `401 Unauthorized`.
- Extract `account_login` **strictly from the verified JWT claims** (`account_login` / `login`). **NEVER trust `userId` from the request body or query params.**
- Derive `broker_id` from the verified JWT / gateway's canonical broker ID (normalized lowercase, e.g., `"orrnn"`). If the request includes `X-Broker-ID` and it does not match (case-insensitive), reject with `403 Forbidden`.
- Read optional `X-Client-ID` header (trimmed string, max 128 chars, e.g. `drw-<uuid>`) and include it as `originClientId` in the real-time broadcast so the originating tab can ignore its own echo while all other devices apply the change immediately.
- Cap request body size at **4 MiB** (`http.MaxBytesReader`) for drawing creates/updates and **64 KiB** for visibility updates.
- Normalize `symbol` with `strings.ToUpper(strings.TrimSpace(symbol))` and `timeframe` with `strings.ToUpper(strings.TrimSpace(timeframe))`.

#### Endpoints Specification

1. **`GET /api/v2/drawings`**
   - Optional query params:
     - `symbol` (e.g., `EURUSD`) — when omitted, returns **all** drawings across all symbols for this account.
     - `timeframe` (e.g., `M1`) — **IMPORTANT**:
       - When `timeframe` is **omitted**, return **ALL drawings for that symbol regardless of timeframe** (this enables symbol-wide sync so drawing on `EURUSD` shows on `EURUSD` on other systems regardless of active timeframe).
       - When `timeframe` is **provided**, return drawings where `timeframe = $tf OR timeframe = ''`.
   - Response (`200 OK`):
     ```json
     {
       "success": true,
       "brokerId": "orrnn",
       "accountLogin": 200010,
       "revision": 12,
       "drawings": [
         {
           "id": "d-1763532000000-ab12c",
           "type": "trendline",
           "symbol": "EURUSD",
           "timeframe": "M1",
           "userId": "200010",
           "properties": {
             "id": "d-1763532000000-ab12c",
             "points": [
               { "time": 1763531400, "price": 1.0845 },
               { "time": 1763532000, "price": 1.0890 }
             ],
             "color": "#3b82f6",
             "lineWidth": 2,
             "lineStyle": "solid",
             "locked": false
           },
           "createdAt": "2026-11-19T06:00:00.123456Z",
           "updatedAt": "2026-11-19T06:00:00.123456Z"
         }
       ],
       "drawingsHidden": false,
       "hiddenMap": {
         "*": false,
         "EURUSD::*": false
       }
     }
     ```
   - Order `drawings` deterministically by `created_at ASC, drawing_id ASC`.

2. **`POST /api/v2/drawings`** (Create or Upsert Drawing)
   - Request body:
     ```json
     {
       "id": "optional-existing-server-id",
       "type": "trendline",
       "symbol": "EURUSD",
       "timeframe": "M1",
       "properties": {
         "id": "d-1763532000000-ab12c",
         "points": [{ "time": 1763531400, "price": 1.0845 }],
         "color": "#3b82f6"
       }
     }
     ```
   - Validation: `symbol` and `type` are required (`400 Bad Request` if missing).
   - ID resolution: use `req.ID` if non-empty; else `properties.id` if non-empty; else generate `"drw-" + hex(8 random bytes)`.
   - Upsert into `public.chart_drawings` (preserving `created_at` on update, updating `drawing_type`, `symbol`, `timeframe`, `properties`, `revision`, `updated_at`).
   - Increment `chart_drawing_revisions` in the same DB transaction.
   - After commit succeeds, publish real-time event **`drawing_upsert`** (Step 3 & 4).
   - Response (`200 OK`):
     ```json
     {
       "success": true,
       "drawingId": "d-1763532000000-ab12c",
       "message": "Drawing saved",
       "revision": 13,
       "drawing": { "...full ServerDrawing object..." }
     }
     ```

3. **`PUT /api/v2/drawings/{id}`** (Update / Upsert by Path ID)
   - Path param `{id}` (URL-unescaped) is the canonical `drawing_id`.
   - Same upsert logic, transaction, revision bump, and **`drawing_upsert`** broadcast as `POST /api/v2/drawings`.
   - Response (`200 OK`): same shape as `POST` (`message: "Drawing updated"`).

4. **`DELETE /api/v2/drawings/{id}`** (Delete Single Drawing)
   - Delete matching row where `(broker_id, account_login)` matches AND (`drawing_id = $id OR client_drawing_id = $id`).
   - If a row was deleted: bump `revision` in the same transaction, commit, and publish real-time event **`drawing_delete`**.
   - If not found: return `200 OK` with `{ "success": true, "deleted": false, "revision": currentRev }` (idempotent delete).
   - Response (`200 OK`):
     ```json
     {
       "success": true,
       "deleted": true,
       "revision": 14
     }
     ```

5. **`DELETE /api/v2/drawings`** (Clear Drawings for Symbol / Symbol+Timeframe / Account)
   - Optional query params: `symbol`, `timeframe`.
     - If `symbol` is set and `timeframe` is empty: delete all drawings for `(broker_id, account_login, symbol)`.
     - If both `symbol` and `timeframe` are set: delete drawings for `(broker_id, account_login, symbol)` where `timeframe = $tf OR timeframe = ''`.
     - If both empty: delete all drawings for `(broker_id, account_login)`.
   - Bump `revision`, commit, and publish real-time event **`drawings_clear`**.
   - Response (`200 OK`):
     ```json
     {
       "success": true,
       "deletedCount": 3,
       "revision": 15
     }
     ```

6. **`GET /api/v2/drawings/visibility` and `PUT /api/v2/drawings/visibility`**
   - `GET`: Optional `symbol`, `timeframe` query params. Returns `{ success: true, brokerId, accountLogin, revision, drawingsHidden, hiddenMap }`.
   - `PUT` (also accept `POST`):
     ```json
     {
       "symbol": "EURUSD",
       "timeframe": "M1",
       "drawingsHidden": true
     }
     ```
     - Upsert `scope_key` (`"*"` if symbol empty, `"<SYM>::*"` if timeframe empty, `"<SYM>::<TF>"` otherwise) AND `"*"` (account-wide toggle) in `public.chart_drawing_visibility`, bump `revision`, commit, and publish **`drawing_visibility`**.
     - Response (`200 OK`): `{ success: true, brokerId, accountLogin, revision, symbol, timeframe, drawingsHidden, hiddenMap }`.

---

### Step 3: Extend `rtx5-tcp-protocol` with `BinaryTradeEventDrawings` (`EventKind = 7`)

In `pkg/rtx5-tcp-protocol/binary_trade_events.go` (shared across `rtx5-gateway`, `broker-tcp-access-server`, `web-terminal-server`, `desktop-clients`):

```go
const (
	// BinaryTradeEvent EventKind codes (1..7).
	BinaryTradeEventPositions uint8 = 1
	BinaryTradeEventOrders    uint8 = 2
	BinaryTradeEventAccount   uint8 = 3
	BinaryTradeEventMetrics   uint8 = 4
	BinaryTradeEventDeals     uint8 = 5
	BinaryTradeEventState     uint8 = 6
	BinaryTradeEventDrawings  uint8 = 7 // Real-time cross-device chart drawing sync
)
```

> **Wire compatibility note:** `BinaryTradeEventVersion` stays `1`. Existing `EncodeBinaryTradeEvent` / `DecodeBinaryTradeEvent` and existing client binaries (`web-terminal-server/binary_stream.go`, `desktop-clients/clientcore/binary_stream.go`, `src/services/binaryTcpMarketStream.ts`) already pass `EventKind = 7` straight through to every tab logged into `AccountLogin`!

---

### Step 4: Publish Live Events from `rtx5-gateway` & Fan Out via `broker-tcp-access-server` (`:4443`) + `:8190` `RTO\x01` + `/ws/v2`

After EVERY successful drawing DB commit in `rtx5-gateway`, publish the event through the **exact same account-event broadcast path used by trades/positions**:

1. **NATS Publish**:
   - Subject: `rtx5.drawings.<account_login>` (e.g., `rtx5.drawings.200010`)
   - Payload: UTF-8 JSON event (exact schemas in Section 5 below).
2. **Direct `:8190` `RTO\x01` Push Stream** (for co-located `rtx5-web-terminal-server` `0.0 ms` fanout):
   - Encode `rtx5tcp.BinaryTradeEvent{ EventKind: rtx5tcp.BinaryTradeEventDrawings, AccountLogin: login, TimestampMs: nowMs, Channel: fmt.Sprintf("drawings.%d", login), Data: jsonBytes }` and push to the `:8190` trade-event push subscribers.
3. **`broker-tcp-access-server` (`:4443`)**:
   - Subscribe to NATS subject `rtx5.drawings.*` (alongside `rtx5.positions.*`, `rtx5.orders.*`, `rtx5.account.*`, `rtx5.metrics.*`, `rtx5.deals.*`, `rtx5.state.*`).
   - Map `rtx5.drawings.<login>` -> `EventKind = rtx5tcp.BinaryTradeEventDrawings` (`7`), `AccountLogin = <login>`, `Channel = "drawings.<login>"`.
   - Fan out the encoded `0x3A` (`FrameBinaryTradeEvent`) frame to **EVERY open `:4443` Binary TCP tunnel whose `0x3B` subscription matches `<login>`**.
   - **Important check on `natsPushDedup`:** Make sure dedup key includes `eventKind` + `revision` (or full payload hash), so rapid drawing drags/edits are NEVER falsely deduplicated against earlier revisions or trade events!
   - **Important check on `BinaryTradeEventMaxWireBytes` (`65,000` bytes):**
     - `22 + len(Channel) + len(Data)` MUST be `<= 65000`.
     - If `len(jsonBytes) <= 60000` (true for 99.9% of drawings), send the full JSON event inside `0x3A` `Data`.
     - If `len(jsonBytes) > 60000` (e.g. a huge freehand sketch or `ghost_feed` `seriesSnapshot`), DO NOT fail or drop the notification — instead send a tiny `drawing_resync` JSON event (~200 bytes, see Section 5.5) inside `0x3A` so every listening client immediately fetches the full state via `GET /api/v2/drawings?symbol=<SYMBOL>`.
4. **`/ws/v2` WebSocket Hub (Legacy / Non-Binary-Stream Clients)**:
   - Also forward `rtx5.drawings.<login>` onto the account's `/ws/v2` WebSocket connection as `{ "type": "channel_message", "channel": "drawings.<login>", "data": <event JSON> }` so non-binary-TCP web clients also sync live.

---

## 5. Exact Real-Time Event JSON Payloads (Contract with Frontend)

Every `0x3A` `Data` payload on `channel: "drawings.<account_login>"` MUST be one of these 5 JSON objects:

### 5.1 `drawing_upsert` (on `POST /api/v2/drawings` and `PUT /api/v2/drawings/{id}`)
```json
{
  "type": "drawing_upsert",
  "brokerId": "orrnn",
  "accountLogin": 200010,
  "revision": 13,
  "originClientId": "drw-9f2c1b0a-...",
  "drawing": {
    "id": "d-1763532000000-ab12c",
    "type": "trendline",
    "symbol": "EURUSD",
    "timeframe": "M1",
    "userId": "200010",
    "properties": {
      "id": "d-1763532000000-ab12c",
      "points": [
        { "time": 1763531400, "price": 1.0845 },
        { "time": 1763532000, "price": 1.0890 }
      ],
      "color": "#3b82f6",
      "lineWidth": 2,
      "lineStyle": "solid",
      "locked": false
    },
    "createdAt": "2026-11-19T06:00:00.123456Z",
    "updatedAt": "2026-11-19T06:00:00.123456Z"
  }
}
```

### 5.2 `drawing_delete` (on `DELETE /api/v2/drawings/{id}`)
```json
{
  "type": "drawing_delete",
  "brokerId": "orrnn",
  "accountLogin": 200010,
  "revision": 14,
  "originClientId": "drw-9f2c1b0a-...",
  "drawingId": "d-1763532000000-ab12c",
  "clientDrawingId": "d-1763532000000-ab12c",
  "symbol": "EURUSD",
  "timeframe": "M1"
}
```

### 5.3 `drawings_clear` (on `DELETE /api/v2/drawings`)
```json
{
  "type": "drawings_clear",
  "brokerId": "orrnn",
  "accountLogin": 200010,
  "revision": 15,
  "originClientId": "drw-9f2c1b0a-...",
  "symbol": "EURUSD",
  "timeframe": ""
}
```

### 5.4 `drawing_visibility` (on `PUT /api/v2/drawings/visibility`)
```json
{
  "type": "drawing_visibility",
  "brokerId": "orrnn",
  "accountLogin": 200010,
  "revision": 16,
  "originClientId": "drw-9f2c1b0a-...",
  "symbol": "EURUSD",
  "timeframe": "M1",
  "accountWide": true,
  "drawingsHidden": true,
  "hiddenMap": {
    "*": true,
    "EURUSD::M1": true
  }
}
```

### 5.5 `drawing_resync` (fallback when a single drawing payload exceeds `60,000` bytes)
```json
{
  "type": "drawing_resync",
  "brokerId": "orrnn",
  "accountLogin": 200010,
  "revision": 17,
  "originClientId": "drw-9f2c1b0a-...",
  "symbol": "EURUSD",
  "timeframe": "M1",
  "drawingId": "d-huge-freehand-1"
}
```

---

## 6. Deployment & Release Checklist (Backend Team)

1. Implement schema migration + `/api/v2/drawings*` handlers + NATS / `:8190` publish in **`rtx5-gateway`**.
2. Subscribe to `rtx5.drawings.*` and fan out `0x3A` (`EventKind = 7`, `Channel = "drawings.<login>"`) to matching `0x3B`-subscribed tunnels in **`broker-tcp-access-server` (`:4443`)**.
3. Verify `EventKind = 7` is defined in **`rtx5-tcp-protocol/binary_trade_events.go`** and passes through `EncodeBinaryTradeEvent` / `DecodeBinaryTradeEvent` without restriction.
4. Build and deploy updated `rtx5-gateway` + `broker-tcp-access-server` binaries to the Broker VPS (`51.195.188.172:4443` / `185.126.217.108:4443`).
5. Confirm all mandatory backend stress tests still pass with zero regression:
   - `verify_sub05ms_calc_sync` (`< 0.5 ms` order execution untouched)
   - `sandbox_flood_crash_stress` (`0` deadlocks, `0` crashes)

---

## 7. Acceptance Criteria (How We Will Verify Backend Is Ready)

1. **PostgreSQL Durability**: `POST /api/v2/drawings` persists to `public.chart_drawings`; restarting `rtx5-gateway` still returns the drawing on `GET /api/v2/drawings?symbol=EURUSD`.
2. **Strict Security & Isolation**:
   - Missing / expired / tampered JWT -> `401 Unauthorized`.
   - Wrong `X-Broker-ID` -> `403 Forbidden`.
   - Account `200011` calling `GET /api/v2/drawings?symbol=EURUSD` never sees drawings created by `200010` and never receives `200010`'s `0x3A` drawing frames.
3. **Cross-System Live Push (Zero Refresh)**:
   - Open two separate `:4443` Binary TCP sessions (e.g. one from Laptop A local dev bridge and one from the deployed Web Terminal VPS or Desktop `.exe`), both subscribed via `0x3B` to `AccountLogin = 200010`.
   - Call `POST /api/v2/drawings` (with `X-Client-ID: device-A`) from Laptop A.
   - Verify **both** sessions receive `0x3A` (`EventKind = 7`, `Channel = "drawings.200010"`, `type = "drawing_upsert"`, `originClientId = "device-A"`) within `< 50 ms`.
   - Repeat for `PUT /api/v2/drawings/{id}`, `DELETE /api/v2/drawings/{id}`, `DELETE /api/v2/drawings?symbol=EURUSD`, and `PUT /api/v2/drawings/visibility`.
4. **Oversized Drawing Handling**: `POST /api/v2/drawings` with a `100 KB` `properties` payload saves cleanly to PostgreSQL and pushes `drawing_resync` over `0x3A` without exceeding `BinaryTradeEventMaxWireBytes` (`65,000` bytes).

---

## 8. Frontend Follow-Up (Once Backend Team Confirms Section 7 Passes)

Once the backend endpoints and `0x3A` `drawings.<login>` fanout are live, we will update `Broker-Terminal-UI-TCP`:
1. Switch `src/services/drawingApi.ts` from `/api/fix/drawings` to `/api/v2/drawings`.
2. Update `src/services/drawingSyncService.ts` to consume live `0x3A` events (`eventKind === 7` / `channel === "drawings.<login>"`) from `binaryTcpMarketStream.subscribeTradeEvents(...)` (the exact same live stream used by trades!), with `drawing_resync` fallback and `/ws/v2` fallback.
3. Remove the local-disk interception in `web-terminal-server/drawings_sync.go` & `web-terminal-server/main.go` so `web-terminal-server` stays stateless and proxies `/api/v2/drawings*` cleanly to `rtx5-gateway`.
4. Sync drawings symbol-wide (so drawing on `EURUSD` shows on `EURUSD` across devices without refresh, even if timeframes differ) and handle reconnect snapshot reconciliation cleanly.
