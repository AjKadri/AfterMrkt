# AfterMrkt frontend API

This document describes the product-facing, read-only API for the separate AfterMrkt UI. The browser calls the AfterMrkt server only. It never calls Bitget, SEC EDGAR, Qwen, or the MCP endpoint directly.

## Common response envelope

Every successful response uses:

```json
{
  "mode": "LIVE",
  "asOf": "2026-09-30T21:11:29.078Z",
  "freshness": {
    "state": "fresh",
    "reason": "provider timestamp is within the provisional fresh window",
    "ageMs": 57,
    "clockSkewMs": 51,
    "timestampConflict": false,
    "providerTimestamp": "2026-09-30T21:11:29.000Z",
    "receivedAt": "2026-09-30T21:11:29.078Z"
  },
  "data": {},
  "sourceRefs": [],
  "warnings": []
}
```

Product routes expose UI-friendly source references in both `sourceRefs` and the product `data.sources` collection where it is present. Product source references contain only `sourceId`, `sourceType`, `label`, `url`, and `observedAt`. Internal execution diagnostics may still use the older technical source-reference shape.

`mode` is explicit. `LIVE` means the server queried the public provider. `REPLAY` means the response came from an immutable captured case and made no provider calls. A replay timestamp must never be presented as a current live quote.

Freshness states are `fresh`, `stale`, and `unavailable`. A stale or unavailable book remains visible as such. It is never silently promoted to current data. Section states use `available`, `unavailable`, `pending`, `stale`, and `not_applicable`.

## Execution capabilities

Instrument, context, simulation, and replay responses expose:

```json
{
  "simulation": "available",
  "bitgetDemoReality": "unsupported_or_inaccessible",
  "liveExecution": "disabled"
}
```

This capability object is descriptive. No route in this contract submits an order. The public UI must not advertise an Execute-on-Demo action from this object.

## Instrument list

`GET /api/instruments?limit=12`

The limit is optional and bounded by the server. The list is intentionally lightweight. It does not include full books, SEC records, Qwen output, or replay payloads.

```json
{
  "instruments": [
    {
      "providerSymbol": "RNVDAUSDT",
      "nativeTicker": "NVDA",
      "companyName": null,
      "status": "online",
      "lastPrice": "228.70",
      "bid": "228.69",
      "ask": "228.71",
      "spreadBps": "0.8737",
      "sessionStatus": "closed",
      "moveSinceNativeClosePercent": "0.14",
      "eventContextStatus": "checked-no-qualifying-material-event",
      "liquidityStatus": "execution-normal",
      "freshness": {},
      "warnings": []
    }
  ],
  "executionCapabilities": {}
}
```

Symbols are copied from Bitget. The server never reconstructs an rToken symbol from the native ticker. The list ranks mapped online Reality instruments using preserved provider turnover fields for informational ordering only. Turnover units are unresolved and are not used as a safety or execution classification.

## Instrument context

`GET /api/instruments/:symbol/context`

The context payload is the product model. The UI does not assemble it from ticker, book, calendar, event, and candle records.

```json
{
  "mode": "LIVE",
  "asOf": "2026-09-30T21:11:29.078Z",
  "instrument": {},
  "session": {},
  "closeReference": {},
  "moveSinceClose": {},
  "market": {},
  "liquidity": {},
  "eventContext": {},
  "nativePriceConfirmation": {},
  "explanation": {
    "headline": "NVDA rToken move since native close: +0.14%",
    "summaryPoints": [],
    "warnings": []
  },
  "limitations": [],
  "warnings": [],
  "sources": [],
  "executionCapabilities": {}
}
```

`closeReference` is an observed rToken candle at the provider-derived native regular-session close. `moveSinceClose` is rToken price versus that rToken reference. It is not a native equity return, fair-value estimate, or prediction. Native-price confirmation is currently explicit and unavailable when the official equities MCP cannot be reached.

`liquidity` is position-independent. It reports the observed book, configured depth bands, and deterministic execution condition. A hypothetical quantity is required for an exit simulation.

## Order book

`GET /api/instruments/:symbol/orderbook`

This route remains available for diagnostics and snapshot inspection. It returns a server-issued immutable order-book snapshot and deterministic metrics. The UI should prefer the context and simulation product fields for the main journey.

## Exit simulation

`POST /api/execution/simulations`

The normal UI request is deliberately small:

```json
{
  "symbol": "RNVDAUSDT",
  "quantity": "0.05"
}
```

The server fetches the current public book, stores an immutable snapshot for the request, and walks bids from highest price down. An optional `maximumAcceptableSlippageBps` may be supplied. The older server-issued `snapshotId` plus `requestedQuantity` form remains accepted for diagnostics and compatibility.

The product response includes:

```json
{
  "symbol": "RNVDAUSDT",
  "currentPrice": "228.70",
  "requestedQuantity": "0.05",
  "filledQuantity": "0.05",
  "unfilledQuantity": "0",
  "bestBid": "228.69",
  "midpoint": "228.70",
  "estimatedVwap": "228.69",
  "estimatedProceeds": "11.4345",
  "spreadBps": "0.437",
  "slippageBps": "0.219",
  "slippageVsBestBidBps": "0",
  "levelsConsumed": 1,
  "executableWithin25Bps": "0.05",
  "executableWithin50Bps": "0.05",
  "executableWithin100Bps": "0.05",
  "fillRatioWithin25Bps": "1",
  "fillRatioWithin50Bps": "1",
  "fillRatioWithin100Bps": "1",
  "deepestConsumedPrice": "228.69",
  "condition": "execution-normal",
  "reasons": [],
  "bookAsOf": "2026-09-30T21:11:29.000Z",
  "receivedAt": "2026-09-30T21:11:29.078Z",
  "freshness": {},
  "disclaimer": "observed-book-estimate-not-guaranteed-fill",
  "sources": [],
  "executionCapabilities": {}
}
```

This is an estimate based on the observed book. It is not a guaranteed fill, does not model queue position or future book changes, and does not submit an order.

The execution condition labels are deterministic and include machine-readable reasons: `execution-normal`, `wide-spread`, `thin-book`, `execution-impaired`, `stale-book`, `execution-unavailable`, and `invalid-book`. Thresholds are provisional demo constants and are not statistically validated.

## Events and analysis

`GET /api/instruments/:symbol/events`

Returns source facts, the event context state, validated interpretations where available, and UI-friendly source references. A source event is marked `kind: "source-fact"`. An interpretation is marked `kind: "ai-interpretation"`.

`GET /api/events/:eventId`

Returns one source fact and its latest validated, quarantined, unavailable, or pending interpretation.

`GET /api/events/:eventId/analysis`

Returns the same event-specific analysis view. Validated analysis exposes `eventType`, `materiality`, `facts`, `uncertainties`, `evidence`, `model`, `providerReportedModel`, `processedAt`, `confidence`, and `sourceBound`. Prompts, prompt contents, and provider credentials are never exposed.

Pending, quarantined, unavailable, and insufficient evidence remain distinct from a negative source finding. The normal context path reads persisted event records and never calls Qwen.

## Replay

`GET /api/replays`

Returns a small curated list:

```json
{
  "replays": [
    {
      "caseId": "...",
      "symbol": "RNVDAUSDT",
      "nativeTicker": "NVDA",
      "asOf": "2026-08-26T20:51:19.000Z",
      "title": "NVDA market and event evidence replay",
      "hasEvent": true,
      "hasMarketSnapshot": false,
      "hasOrderBook": false,
      "simulationAvailable": false
    }
  ],
  "executionCapabilities": {}
}
```

`GET /api/replays/:id` returns the replay detail and immutable manifest hash. `GET /api/replays/:id/context` returns the same product context shape with `mode: "REPLAY"`. `POST /api/replays/:id/simulations` accepts `{ "quantity": "0.05" }` and is available only for a case with both a captured market snapshot and order book. Event-only cases remain clearly non-simulatable.

Replay cases are selected from persisted captures. The API does not fabricate historical market snapshots or attach a current timestamp to historical evidence.

The server reads normal market replays from `AFTERMRKT_DATA_DIR`. An optional `AFTERMRKT_EVENT_REPLAY_DATA_DIR` can point to a separate capture directory containing event-only replay manifests, such as the validated historical NVDA evidence. This keeps event-only evidence separate from current market captures without merging incompatible storage assumptions.

## Product error codes

Public market, simulation, and replay failures use these stable codes:

`instrument_not_found`, `market_data_unavailable`, `market_data_stale`, `session_unavailable`, `event_evidence_unavailable`, `simulation_invalid_quantity`, `simulation_book_unavailable`, `replay_not_found`, and `replay_unavailable`.

Provider error codes and raw provider messages remain server-side diagnostics. A source can still be present in a partial context while another section is `unavailable`.

## Current limitations

- Generic public Bitget market data is the canonical MVP source for rToken ticker, order book, fills, and candles.
- Reality-specific raw order-book and fill routes remain inaccessible without the required provider access state. The UI should not imply that generic public depth is a proprietary Reality feed.
- The official Bitget equities MCP is unreachable from the current Codex environment, so native price confirmation is unavailable.
- Demo Reality acquisition and order-query probes were bounded and ended in an unsupported or inaccessible state. No order was submitted and the public contract does not advertise Demo execution.
- Qwen analysis is persisted only when it has passed local validation. Normal market context does not call Qwen.
- Freshness windows and execution thresholds are provisional operational constants, not statistical claims.
