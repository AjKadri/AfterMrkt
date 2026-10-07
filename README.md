# AfterMrkt

AfterMrkt is decision support for reading an off-hours Bitget rToken move and estimating what an existing position could absorb before the U.S. market reopens.

Live demo: https://aftermrkt.ajkadri.dev/ (workspace at `/workspace`).

## The 30-second story

The problem is simple: an after-hours price move leaves the trader asking what changed, why it moved, and what an exit would cost. AfterMrkt answers those questions with a bounded decision frame:

1. Bitget public market data supplies the exact rToken symbol, current context, and observed order book.
2. Deterministic logic computes the move, freshness, spread, depth, VWAP, slippage, fill, and unfilled quantity.
3. SEC source records provide evidence when a qualifying event is available. Qwen classifies or explains only that bounded evidence and the prepared context. Qwen does not calculate financial values or choose a trade.
4. The trader chooses hold, partial exit, or full exit. Manual decisions are recorded as `SIMULATED`. Live execution is disabled and no order is created.

The product is a decision lens, not a prediction engine, broker, wallet, or autonomous trader.

## Demo flow

Run the local server, open `/workspace`, select an instrument, and enter a position in units. Review the move and evidence state, then inspect the observed-book estimates for 25%, 75%, and the full position. Use Ask AfterMrkt for questions such as:

- What is the biggest uncertainty here?
- What does liquidity mean for my exit?
- Why did this move?

Choose a decision and confirm the paper record. The result must remain visibly `SIMULATED` or `EXECUTION UNAVAILABLE`; it never becomes an exchange order.

The landing page is `/`, the live workspace is `/workspace`, documentation is `/docs`, and captured historical cases are `/replay`.

## Trust boundary

Bitget public routes are the current market-data source. The generic public order book is explicitly distinct from authenticated Bitget Reality depth and fills. Exact-decimal calculations and execution guards stay in AfterMrkt code. SEC records remain source-bound. Qwen is an optional, separately validated explanation layer. It cannot introduce timestamps, numeric financial claims, execution instructions, balances, or orders.

The current capability contract is:

| Capability                                      | State                         |
| ----------------------------------------------- | ----------------------------- |
| Public market data and observed-book simulation | `available`                   |
| Bitget Demo Reality account access              | `unsupported_or_inaccessible` |
| Native-stock price confirmation                 | `unavailable`                 |
| Live execution                                  | `disabled`                    |
| Manual decision record                          | `SIMULATED`                   |

`LIVE` means current public provider context. `REPLAY` means immutable captured records with no provider calls. `SIMULATED` means deterministic math, not an executed order. Missing Qwen, SEC, native-price, Reality, and replay capabilities remain visible as unavailable instead of being replaced with mock values.

## Local setup

```sh
npm install
cp .env.example .env
npm run dev:server
```

Open `http://127.0.0.1:3000/`. The browser calls the local AfterMrkt API only. It never calls Bitget, SEC EDGAR, Qwen, or the MCP endpoint directly.

For a hosted Node service:

```sh
npm ci
npm run build
npm start
```

The production shape is a long-lived Node process with persistent storage mounted at `AFTERMRKT_DATA_DIR`. A serverless function platform is not a supported fit for the current runtime because the app owns an HTTP server and uses local mutable file stores for execution records and captured replay data. No deployment is performed by this repository.

## Environment variables

The defaults in `.env.example` are enough for public Bitget market data and local development.

- `PORT` and `AFTERMRKT_HOST` control the Node listener. The host defaults to `0.0.0.0` for hosted runtimes. Use `AFTERMRKT_HOST=127.0.0.1` for a local-only listener.
- `AFTERMRKT_DATA_DIR` selects the persistent directory for captures, replay records, and manual decision records. It defaults to `.agent/data`.
- `AFTERMRKT_EVENT_REPLAY_DATA_DIR` points to an optional directory containing event replay records.
- `QWEN_API_KEY` enables the separate workspace, decision stress-test, and event interpretation calls. Without it, Qwen is explicitly unavailable while deterministic context remains usable.
- `AFTERMRKT_ASSISTANT_RATE_PER_MINUTE` (default `10`) limits Qwen-backed requests per client per minute, keyed by the first `x-forwarded-for` entry or the socket address. `AFTERMRKT_ASSISTANT_DAILY_CAP` (default `500`) is a global cap per UTC day. Requests over either limit receive HTTP 429.
- `QWEN_BASE_URL`, `QWEN_MODEL`, timeout, output, and thinking settings configure the Qwen adapter. The hackathon defaults are `https://hackathon.bitgetops.com/v1` and `qwen3.8-max`.
- `SEC_USER_AGENT` is required only for SEC EDGAR retrieval. It must include a real contact address when live SEC collection is used.
- `BITGET_BASE_URL`, `BITGET_SYMBOL`, and `BITGET_SYMBOL_LIMIT` configure public-data probes. No Bitget account credentials are required for the public routes used by the workspace.
- `MCP_ENDPOINT` and `MCP_NATIVE_TICKER` support native-price capability probes. Native confirmation remains unavailable in the product.
- Bitget Demo credentials are probe-only and do not enable product execution. Live credentials and live orders are not supported.

## Checks and probes

```sh
npm run check
npm run build
git diff --check
```

The main check runs formatting, lint, typecheck, and the full Vitest suite. Targeted capability probes include:

```sh
npm run probe:bitget
npm run probe:capture
npm run probe:context
npm run probe:event-pipeline
npm run probe:qwen
npm run probe:replay
```

Probe evidence is written to the ignored `.agent/evidence/` directory. Public Bitget probes need no credentials. Qwen, SEC, MCP, and Demo probes report unavailable or authentication failures when their configured capability cannot be reached. No probe places an order. The local file store is suitable for a judge demo and local development, not a multi-instance production database.

## Repository notes

Read [AGENTS.md](AGENTS.md) before changing the project. The current phase keeps deterministic market data, evidence, replay, and simulation boundaries explicit. It does not enable wallets, live accounts, Demo Reality execution, live orders, or autonomous trading.
