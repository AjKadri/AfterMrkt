# AfterMrkt

AfterMrkt is a read-only decision-support foundation for Bitget Reality market data. The current milestone normalizes the live public instrument universe, captures immutable public snapshots, computes exact-decimal market quality, and estimates position-aware exits against an observed bid book. It also supports deterministic replay from captured snapshots. It does not contain product screens, wallet support, live account connections, or order submission.

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

## Read-only API

Start the backend with `npm run dev:server`. It exposes `GET /api/instruments`, `GET /api/instruments/:symbol/context`, `GET /api/instruments/:symbol/orderbook`, and `POST /api/execution/simulations`. When a capture store is configured by the server, it also exposes `GET /api/replays`, `GET /api/replays/:id`, and `POST /api/replays/:id/simulations`. Replay routes load immutable snapshots only and make no provider calls. Simulation routes return observed-book estimates and never submit an order.

Freshness windows and execution labels are provisional configuration constants. They are visible in `src/domain/freshness.ts` and `src/domain/market-quality.ts` and are not statistically validated thresholds.

The public generic order-book source is identified as `bitget_generic_spot_orderbook`. It is the verified MVP source and is kept distinct from the authenticated Reality-specific route. `turnover24h` and `platformTurnover24h` are preserved separately with unknown units and are not treated as verified market-quality inputs.

Read [AGENTS.md](AGENTS.md) and [.agent/TASK.md](.agent/TASK.md) before changing the project.
