# AfterMrkt

AfterMrkt is a read-only decision-support application for Bitget Reality market data. It normalizes the live public instrument universe, captures immutable public snapshots, computes exact-decimal market quality, estimates position-aware exits against an observed bid book, and supports deterministic replay from captured snapshots. The integrated UI is served by the same local Node server. It does not provide wallet support, live account connections, or order submission.

## Setup

```sh
npm install
cp .env.example .env
```

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm run check
npm test
```

## Probes

```sh
npm run probe:bitget
npm run probe:candidates
npm run probe:diagnostics
npm run probe:orderbook-asymmetry
npm run probe:capture
npm run probe:live-simulation
npm run probe:mcp
npm run probe:mcp-transport
npm run probe:qwen
```

Probe evidence is written to the ignored `.agent/evidence/` directory. Public Bitget probes need no credentials. The MCP and Qwen probes report unavailable or authentication failures when their configured capability cannot be reached. No probe places an order.

`npm run probe:capture` writes development-only immutable capture records under `.agent/data/` by default and creates a replay manifest for the first watched symbol with complete snapshots. Set `AFTERMRKT_DATA_DIR` to use another local directory. The file store is a persistence implementation for local development, not a claim of production database durability. Identical provider snapshots are content-addressed and retries are deduplicated.

## Local application

Start the application with `npm run dev:server` and open `http://127.0.0.1:3000/`. The landing page is at `/`, the live workspace is at `/workspace`, product documentation is at `/docs`, and historical cases are at `/replay`. The browser calls the AfterMrkt API only. It never calls Bitget, SEC EDGAR, Qwen, or the MCP endpoint directly.

The server exposes `GET /api/instruments`, `GET /api/instruments/:symbol/context`, `GET /api/instruments/:symbol/orderbook`, `POST /api/execution/simulations`, `POST /api/assistant/query`, `POST /api/execution/decisions`, and the event and replay routes documented in [docs/frontend-api.md](docs/frontend-api.md). The workspace now moves from simulation to an explicit Hold, partial-exit, or full-exit trader decision. Its single-turn Ask AfterMrkt panel explains only server-reconstructed, source-grounded context. Manual positions remain `SIMULATED`; confirmation records the decision and reports `EXECUTION UNAVAILABLE` without creating a fake order. Replay routes load immutable snapshots only and make no provider calls. Simulation routes return observed-book estimates and never submit an order.

Freshness windows and execution labels are provisional configuration constants. They are visible in `src/domain/freshness.ts` and `src/domain/market-quality.ts` and are not statistically validated thresholds.

The public generic order-book source is identified as `bitget_generic_spot_orderbook`. It is the verified MVP source and is kept distinct from the authenticated Reality-specific route. `turnover24h` and `platformTurnover24h` are preserved separately with unknown units and are not treated as verified market-quality inputs.

Read [AGENTS.md](AGENTS.md) and [.agent/TASK.md](.agent/TASK.md) before changing the project.
