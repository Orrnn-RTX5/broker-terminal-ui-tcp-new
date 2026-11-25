# Changelog - Broker-Terminal-UI-TCP

## [1.2.7] - 2026-11-25 (VERSION file; terminal UI)
### Added (switched off)
- **Pending order expiry type field:** the terminal can send the order's expiry type (GTC, today, specified or specified day) with pending orders, switched OFF by default (`VITE_BINARY_ORDER_EXPIRY_TYPE_TLV_ENABLED`). With the switch off every order frame is byte-identical to 1.2.6; the switch stays off until the matching gateway release (P07-7a) is live.

## [1.2.6] - 2026-11-24 (VERSION file; terminal UI)
### Changed
- **Depth of market and order ticket ladder keep to the current symbol and session:** when you switch symbol, log out or change account, the previous ladder and its error clear at once; a token refresh no longer makes a loaded ladder blink or clear; and late answers from a previous symbol, session or request can no longer overwrite the ladder on screen.
- **MT5 "close by" deals in history:** deals marked as close-by (`entry_out_by` / `out_by`) now count as closing deals in deal history and on the chart, so close-by pairs show as closed positions with the right volume. Today's server still sends them as ordinary closing deals, so nothing changes for current data.
### Added (switched off)
- **Order fill type field:** the terminal can send the order fill type (FOK, IOC or Return) in the binary order message, but this is switched off in this version and every order message is unchanged. It will be switched on in a later version, together with server support.

## [1.2.5] - 2026-11-24 (VERSION file; terminal UI)
### Changed
- **Shown price = execution price for the account:** Market Watch, the order ticket, the depth of market, the chart's Ask line, SL/TP checks and profit now show the same account spread markup that the trade engine applies, rounded the way the engine rounds on the market-order fill path (except the cases under Known limitations); cached and closed-market quotes are widened once from the raw price; deep depth levels follow the shown top, and a level whose shown price would be zero, negative or out of order is dropped.
### Known limitations (accepted by the owner for this release; later updates fix them)
- Accounts filled outside the trade engine (an account with an A-book or hybrid override, or an account without a B-book override in a group with A-book or hybrid routing to an external liquidity provider, or any account when the broker has the fast trade path turned off) are filled without the symbol's fixed spread and spread balance, but this version still applies them to the shown price. On symbols with a fixed spread or a spread balance such accounts can see a price a few points worse than their fill (example: fixed spread 10, no markup: about 4 points on each side).
- Accounts filled by the trade engine see their fill price, except in two cases: on symbols with a symbol-level spread difference the shown price does not include it yet (example: difference 10, no markup: the fill is about 5 points worse on each side than the price shown); and an account whose markup comes only from the platform-wide default group sees no markup (example: markup 4: the fill is about 2 points worse on each side than the price shown).
- SL/TP and pending-order trigger prices are rounded once by the engine and can differ by 1 point on half-point ties; until the account's instrument list has loaded, prices are shown raw, and after the broker changes a markup the old markup is shown until the list is next refreshed.
- Hidden markup that the broker sets on opening prices, and prices confirmed by a dealer, are not part of the shown price, so those fills can differ from it.

## [2.2.4] - 2026-11-05
### Added
- **Live Version Display (`v2.2.4`)**: Unified live version display across Terminal Login Modal, About dialog, status bar, and native/web Binary TCP top toolbar via `VITE_APP_VERSION`, `package.json`, and `/api/tcp-client/status`.
- **Dynamic `yo4x` Broker Discovery (`:9100` -> `:4443`)**: Real-time `.srv` broker directory resolution from Super Admin Hub (`185.126.217.108:9100`) to live broker `yo4x` (`185.126.217.108:4443`) across both Desktop `.exe` and Web Terminal modes with zero hardcoded fallback broker names.
- **Dual Desktop `.exe` + Web Terminal (`https://tcp-terminal.orrnn.com`) Build & OTA Pipeline**: Documented and synchronized single-repository dual-target staging (`05-stage-and-build-uis.ps1` -> `desktop-clients/cmd/rtx5-terminal-client/dist` + `web-terminal-tcp/server/dist`) and Direct `:9100` Binary TCP Ed25519 Auto-Push OTA (`publish-ota-release.ps1` -> `terminal-ui-dist.zip`, `RTX5-Terminal64.exe`, and `web-terminal-linux.zip`).
- **Comprehensive Developer & AI Agent Documentation**: Added `PROJECT_MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `ENGINEERING_RULES.md`, `.github/copilot-instructions.md`, and expanded `README.md` covering the 6-repo `Orrnn-RTX5` Pure Binary TCP ecosystem, `/__rtx5_binary_order_ws` (132B -> `< 0.5 ms` 256-Shard RAM + WAL Engine), `/__rtx5_binary_stream` (`0x21`/`0x22`/`0x3A`), `broker.lic` provisioning, and mandatory post-change sub-0.5ms & request-flooding stress tests.
### Removed
- Removed legacy Web-era `src/locales/NEEDS_TRANSLATION.md` scratch checklist.

## [1.0.0] - 2026-11-04
### Added
- Initial **v1.0.0 Pure Binary TCP Production Release**.
- Synchronized 100% with latest upstream Web codebase (upstream-web/main) as of 2026-11-04.
- Pure Binary TCP (`:4443`) Trader Terminal UI + Web Terminal TCP Server (`6144baca`).
