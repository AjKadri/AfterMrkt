# AfterMrkt

AfterMrkt is a read-only decision-support foundation for Bitget Reality market data. The current milestone normalizes the live public instrument universe, computes exact-decimal market quality, and estimates position-aware exits against an observed bid book. It does not contain product screens, wallet support, live account connections, or order submission.

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
npm run probe:live-simulation
npm run probe:mcp
npm run probe:mcp-transport
npm run probe:qwen
```

Probe evidence is written to the ignored `.agent/evidence/` directory. Public Bitget probes need no credentials. The MCP and Qwen probes report unavailable or authentication failures when their configured capability cannot be reached. No probe places an order.

## Read-only API

Start the backend with `npm run dev:server`. It exposes `GET /api/instruments`, `GET /api/instruments/:symbol/context`, `GET /api/instruments/:symbol/orderbook`, and `POST /api/execution/simulations`. The simulation route accepts a server-issued immutable snapshot ID and returns an observed-book estimate. It never submits an order.

Freshness windows and execution labels are provisional configuration constants. They are visible in `src/domain/freshness.ts` and `src/domain/market-quality.ts` and are not statistically validated thresholds.

Read [AGENTS.md](AGENTS.md) and [.agent/TASK.md](.agent/TASK.md) before changing the project.
