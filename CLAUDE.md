# Scope of this repository

This repo contains **only the Windows side** of the Queue Manager system — the Local Agent that runs as a Windows Service inside the restaurant.

The **cloud side is not included** in this repo. It lives in a separate codebase. Anything described in `docs/PRD_03_cloud_backend.md` (cloud backend, admin panel hosting, central config service, etc.) is reference material for how this agent talks to the cloud — not code that exists here.

## What lives here

- `src/` — the Local Agent (Node.js 20, Windows-targeted)
- `config/` — local config files and examples
- `scripts/install.bat` — Windows install/service registration
- `docs/PRD_*.md` — full product spec for all sides (Windows + cloud + web pages), included for context

## What does NOT live here

- Cloud backend services
- Admin panel server / hosting
- Display page and staff page web app source (those are served by cloud — this agent only consumes their APIs / serves a local fallback per PRD #8)

## When working in this repo

- Treat cloud endpoints as external dependencies — read the PRDs to understand the contract, but do not expect to find or modify cloud code here.
- Linux platform code is reserved for the future (`src/platform/linux/`) — Windows is the only supported target today.
- PRD #8 (`docs/PRD_08_amendments.md`) overrides PRDs #1–7 where they conflict.
