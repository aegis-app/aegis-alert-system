# A.A.S (Aegis Alert System)

| Item | Detail |
|---|---|
| Version | v0.1.0 |
| Status | **Rebuilt from scratch — under re-implementation** |
| Implementation | TypeScript (Node 22, ESM), zero runtime dependencies |

日本語版は [README.ja.md](README.ja.md) を参照。

## Overview

A.A.S (read: "Earth"; functional name: A2S) is the relay hub that
centralizes disaster-information ingest, normalization, and distribution
for the Aegis family (Discord bot, Python / Java / Windows / Android / C#
clients, and the bosai web app). Instead of every client polling upstream
sources on its own, A.A.S ingests once, normalizes into a common event
format, deduplicates, and distributes to all clients.

> **Rebuild notice:** this repository is a from-scratch re-implementation
> of the previous `aegis-alert-system` (v0.10.0). Production still runs the
> previous implementation; this codebase is being rebuilt phase by phase
> with full contract compatibility as the goal, so existing clients will
> switch over unchanged. The plan and the module-by-module parity
> checklist live in [DESIGN.md](DESIGN.md) (Japanese).

## API contract (summary)

Authentication: `Authorization: Bearer <token>` (the SSE endpoint also
accepts `?token=`). The owner listener is for private-network use only;
a separate public listener serves read-only endpoints to named per-client
tokens (the owner token is rejected there).

| Method | Path | Description |
|---|---|---|
| GET | `/v1/status` | Hub status: stored counts and per-source health |
| GET | `/v1/status/public` | Coarse unauthenticated status (for public status pages; no event content) |
| GET | `/v1/events` | Recent events; filter with `kind` / `since` / `limit` |
| GET | `/v1/stream` | SSE stream: replays stored events on connect, then pushes new/updated events |
| GET | `/v1/master` | Master-data index (names, counts, generation dates) |
| GET | `/v1/master/<name>` | One master dataset in its original format |

Master datasets: `stations` (4,361), `station-prefs`, `tsunami-stations`,
`tsunami-zones`, `coastline`, `eew-polygons`, `volcanoes`, `rivers`,
`amedas` (fetched live from JMA).

### Event kinds (14)

`quake`, `eew`, `tsunami`, `warning`, `typhoon`, `flood`, `sediment`,
`tornado`, `record-rain`, `linear-rain`, `volcano`, `river`, `dam`,
`heat`.

Ingest sources: P2P earthquake information (quake / tsunami / EEW),
Wolfx (WebSocket + HTTP fallback), DMDSS (dmdata.jp; EEW forecast under
contract), JMA warnings and typhoons, JMA disaster-information XML
feeds, MLIT river/dam observations (**currently disabled** in production
pending a permanent patrol-load fix), and MOE WBGT heat alerts.

EEW on the public listener is gated: it is delivered only to clients on
an allowlist and only while the EEW supply is DMDSS, because EEW data is
subject to redistribution restrictions.

## Configuration

All configuration is via environment variables; see
[.env.example](.env.example) for the full list with safe localhost
defaults. Never commit a real `.env`.

## Development

This project follows the unified development workflow in
[CONTRIBUTING.md](CONTRIBUTING.md): issue first, branch
`<type>/<issue-number>-<slug>`, PR with `Closes #<number>`, and
"Rebase and merge".

```bash
npm install
npm run build   # tsc -> dist/
npm test        # build + node --test
npm start       # node --env-file-if-exists=.env dist/src/index.js
```

## License

MIT — see [LICENSE](LICENSE). Bundled fonts (added in later phases) are
covered by their own licenses.
