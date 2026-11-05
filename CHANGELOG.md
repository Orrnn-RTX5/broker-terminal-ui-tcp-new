# Changelog - Broker-Terminal-UI-TCP

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
