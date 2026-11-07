# RTX5 TCP — Release Rules

These rules are the same in all 6 repositories:

| Repository | Part |
|---|---|
| `rtx5-production-superadmin-backend-TCP` | Super Admin backend (hub `:9100`, control plane) + desktop clients |
| `rtx5-production-superadmin-UI-TCP` | Super Admin UI |
| `Broker-Backend-V2-TCP` | Broker backend (`:4443`, gateway, services) |
| `Broker-Admin-UI-TCP` | Broker Admin UI |
| `Broker-Manager-UI-TCP` | Broker Manager UI |
| `Broker-Terminal-UI-TCP` | Trader Terminal UI + web terminal server |

## Why

Several people built from different copies of the code. Every build looked
different (different version, version shown in a different place), and nobody
could tell which code was running in production.

## 1. `main` is the only source of truth

- Production runs what is on GitHub `main`. Nothing else.
- Local branches (`feature-parity`, personal branches, agent worktrees) are work
  in progress. Never release from them.

## 2. Every push to `main` deploys to production

The `ota-auto-push.yml` workflow builds and pushes an OTA release to the live hub
(`185.126.217.108:9100`) on **every** push to `main`. Backend pushes restart live
services.

- **Never push directly to `main`.**
- All changes go through a pull request.
- Only the **release owner** merges pull requests into `main`.

## 3. How to make a change

1. `git fetch origin && git switch -c <short-topic> origin/main`
2. Make the change. Build and test it locally.
3. `git push -u origin <short-topic>` and open a pull request to `main`.
4. In the PR, say what changed, how it was tested, and what it restarts in
   production.
5. Keep the branch up to date with `main` (rebase or merge `origin/main`) until
   the release owner merges it.

Pushing a branch or opening a pull request does **not** deploy anything.

## 4. Only CI builds releases

- Release builds (desktop `.exe`, Linux packages, UI bundles) come only from CI or
  the release owner, built from `main`.
- Do not share or install builds made on your own PC. Local builds are for
  testing only.

## 5. One version for everything

- All 6 repositories carry the **same** number in `VERSION`, and it is bumped
  together for each release (one PR per repo, merged together).
- Format: `MAJOR.MINOR.PATCH`, e.g. `1.0.0`.
- Every release is tagged `vMAJOR.MINOR.PATCH` in all 6 repositories, on the
  merged `main` commit.
- Numbering restarts at **`v1.0.0`**. The existing `v1.0.0` tags (2026-11-04) must
  be moved by the release owner before the first unified release.

## 6. Every build shows what it is

- Each build is stamped with its version **and** commit, e.g. `v1.0.0 · a1b2c3d`.
- Every app shows both, in the same place:
  `UI v1.0.0 (a1b2c3d) · Backend v1.0.0 (a1b2c3d)`.
  - Super Admin: Super Admin UI + Super Admin backend (hub).
  - Admin and Manager: their UI + broker backend.
- If two people see different numbers, they are running different code.

## 7. Do not touch without the release owner

- `.github/workflows/*` (CI/CD).
- Release tags.
- The production server (`185.126.217.108`).

## Release checklist (release owner)

1. All PRs for the release are merged into `main` in every repository involved.
2. `VERSION` is the same in all 6 repositories.
3. CI is green for every repository.
4. Tag `vX.Y.Z` in all 6 repositories.
5. Check on the server and in each app that UI and backend show `vX.Y.Z` and the
   expected commit.
