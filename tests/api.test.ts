import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createApiServer } from '../src/api/index.js';
import type { PublicMarketDataProvider } from '../src/adapters/bitget/index.js';
import type { ProviderRecord, NormalizedOrderBook } from '../src/domain/types.js';
import { InMemorySnapshotStore } from '../src/domain/snapshots.js';
import { createReplayCase } from '../src/domain/replay.js';
import { InMemoryCaptureStore } from '../src/persistence/store.js';
import { canonicalJson } from '../src/lib/canonical.js';
import { sha256 } from '../src/lib/hash.js';
import type { EventAnalysis, SourceEvent } from '../src/contracts/events.js';
import type { QwenCall } from '../src/adapters/qwen/index.js';
import type { DecisionStressTestClient } from '../src/domain/decision-stress-test.js';
import type { WorkspaceQuestionClient } from '../src/domain/workspace-question.js';
import { InMemoryExecutionStore } from '../src/persistence/execution-store.js';
import { TEST_FIXTURE_SOURCE, testMarketSnapshotInput, testSnapshot } from './fixtures/market.js';

const NOW = new Date('2026-09-29T22:00:00.000Z');

describe('AfterMrkt API contracts', () => {
  it('exposes a bounded product instrument list and explicit execution capabilities', async () => {
    const server = createApiServer({
      marketData: testProvider(),
      snapshots: new InMemorySnapshotStore(),
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/instruments?limit=1`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          instruments: Array<{
            providerSymbol: string;
            nativeTicker: string | null;
            bid: string | null;
            ask: string | null;
            sessionStatus: string;
            eventContextStatus: string;
            liquidityStatus: string;
            freshness: { state: string };
          }>;
          executionCapabilities: {
            simulation: string;
            bitgetDemoReality: string;
            liveExecution: string;
          };
        };
      };
      expect(body.data.instruments).toHaveLength(1);
      expect(body.data.instruments[0]).toMatchObject({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        bid: '100',
        ask: '101',
        sessionStatus: 'unavailable',
        eventContextStatus: 'unavailable',
        liquidityStatus: 'execution-normal',
        freshness: { state: 'fresh' },
      });
      expect(body.data.executionCapabilities).toEqual({
        simulation: 'available',
        bitgetDemoReality: 'unsupported_or_inaccessible',
        liveExecution: 'disabled',
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('accepts the UI-sized simulation request and returns product fields', async () => {
    const server = createApiServer({ marketData: testProvider(), now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5' }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          symbol: string;
          currentPrice: string | null;
          estimatedVwap: string | null;
          estimatedProceeds: string;
          feeRate: string;
          estimatedFee: string;
          netProceeds: string;
          condition: string;
          reasons: unknown[];
          disclaimer: string;
          executionCapabilities: { simulation: string };
        };
      };
      expect(body.data).toMatchObject({
        symbol: 'RMUUSDT',
        currentPrice: '100.5',
        estimatedVwap: '100',
        estimatedProceeds: '500',
        feeRate: '0.0005',
        estimatedFee: '0.25',
        netProceeds: '499.75',
        condition: 'execution-normal',
        disclaimer: 'observed-book-estimate-not-guaranteed-fill',
        executionCapabilities: { simulation: 'available' },
      });
      expect(body.data.reasons.length).toBeGreaterThan(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('sends rounded numbers and a capped limitation list to the stress test', async () => {
    let packet: Record<string, unknown> | null = null;
    const qwen: DecisionStressTestClient = {
      model: 'qwen3.8-max',
      stressTestDecision: async (input) => {
        packet = input as unknown as Record<string, unknown>;
        return { content: '{}', providerReportedModel: 'qwen3.8-max' } as QwenCall;
      },
    };
    const server = createApiServer({ marketData: testProvider(), now: () => NOW, qwen });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    try {
      await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5', includeDecisionStressTest: true }),
      });
      const sent = packet as Record<string, unknown> | null;
      expect(sent).not.toBeNull();
      for (const [key, value] of Object.entries(sent ?? {})) {
        if (typeof value === 'string' && /^-?[\d.]+%?$/u.test(value)) {
          expect(value.length, key).toBeLessThanOrEqual(16);
        }
      }
      expect(sent?.estimatedFee).toBe('0.25');
      expect(sent?.netProceeds).toBe('499.75');
      expect(sent?.takerFeeRate).toBe('0.05%');
      expect((sent?.limitations as string[]).length).toBeLessThanOrEqual(4);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('runs the decision stress test without a qualifying event and keeps it prose-only', async () => {
    const qwen: DecisionStressTestClient = {
      model: 'qwen3.8-max',
      stressTestDecision: async (input) => {
        expect(input.sourceEventStatus).toBe('not_applicable');
        expect(input.requestedQuantity).toBe('5');
        return {
          content: JSON.stringify({
            immediateExit: 'The captured depth suggests a partial absorbable amount.',
            evidence: 'The deterministic simulation contains the current fill and slippage facts.',
            mainUncertainty: 'The book can change before a later review.',
            considerations: [
              'A smaller decision leaves more exposure.',
              'Immediacy accepts more book impact.',
            ],
            model: 'qwen3.8-max',
            promptVersion: 'decision-stress-test-v2',
          }),
          providerReportedModel: 'qwen3.8-max',
        } as QwenCall;
      },
    };
    const server = createApiServer({ marketData: testProvider(), qwen, now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5', includeDecisionStressTest: true }),
      });
      const body = (await response.json()) as {
        data: {
          estimatedVwap: string;
          decisionStressTest: {
            status: string;
            immediateExit: string;
            inputHash: string;
          };
        };
      };
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        estimatedVwap: '100',
        decisionStressTest: {
          status: 'available',
          immediateExit: 'The captured depth suggests a partial absorbable amount.',
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(JSON.stringify(body.data.decisionStressTest)).not.toContain('estimatedVwap');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('passes validated session and native-close move facts into the stress test', async () => {
    const provider = testProvider();
    provider.getMarketStates = async () => ({
      source: TEST_FIXTURE_SOURCE,
      data: [
        {
          market: 'US',
          stateList: [
            {
              state: 'regular',
              startTime: '09:30',
              endTime: '16:00',
              timeZone: 'America/New_York',
            },
          ],
        },
      ],
    });
    provider.getMarketCalendar = async () => ({
      source: TEST_FIXTURE_SOURCE,
      data: { timeZone: 'America/New_York', regularConfig: ['Saturday', 'Sunday'] },
    });
    provider.getHistoricalCandles = async () => ({
      source: TEST_FIXTURE_SOURCE,
      data: [
        {
          openTime: '2026-09-29T19:59:00.000Z',
          open: '100',
          high: '100',
          low: '100',
          close: '100',
          volume: '1',
          quoteVolume: '100',
          extras: [],
        },
      ],
    });
    let observedInput: Parameters<DecisionStressTestClient['stressTestDecision']>[0] | null = null;
    const qwen: DecisionStressTestClient = {
      model: 'qwen3.8-max',
      stressTestDecision: async (input) => {
        observedInput = input;
        return {
          content: JSON.stringify({
            immediateExit: 'The observed depth presents a trade-off.',
            evidence: 'The deterministic simulation is the evidence.',
            mainUncertainty: 'The next book is unknown.',
            considerations: ['Review the supplied facts.'],
            model: 'qwen3.8-max',
            promptVersion: 'decision-stress-test-v2',
          }),
          providerReportedModel: 'qwen3.8-max',
        } as QwenCall;
      },
    };
    const server = createApiServer({ marketData: provider, qwen, now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5', includeDecisionStressTest: true }),
      });
      expect(response.status).toBe(200);
      expect(observedInput).toMatchObject({
        moveSinceNativeClosePercent: '0.50%',
        sessionState: 'closed',
        nativeTicker: 'MU',
      });
      expect(
        (await response.json()) as { data: { decisionStressTest: { status: string } } },
      ).toMatchObject({
        data: { decisionStressTest: { status: 'available' } },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('keeps the final decision confirmation valid after a slow Qwen response', async () => {
    let currentTimeMs = NOW.getTime();
    const qwen: DecisionStressTestClient = {
      model: 'qwen3.8-max',
      stressTestDecision: async () => {
        currentTimeMs += 20_000;
        return {
          content: JSON.stringify({
            immediateExit: 'The captured depth presents an execution trade-off.',
            evidence: 'The deterministic simulation supplies the execution evidence.',
            mainUncertainty: 'The book may change before confirmation.',
            considerations: ['Review the deterministic facts before confirming.'],
            model: 'qwen3.8-max',
            promptVersion: 'decision-stress-test-v2',
          }),
          providerReportedModel: 'qwen3.8-max',
        } as QwenCall;
      },
    };
    const server = createApiServer({
      marketData: testProvider(),
      qwen,
      now: () => new Date(currentTimeMs),
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const positionResponse = await fetch(`${baseUrl}/api/execution/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5' }),
      });
      const positionBody = (await positionResponse.json()) as {
        data: { position: { positionId: string } };
      };
      const decisionResponse = await fetch(`${baseUrl}/api/execution/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          decision: 'partial_exit',
          requestedQuantity: '2.5',
          orderType: 'market',
        }),
      });
      const decisionBody = (await decisionResponse.json()) as {
        data: {
          decision: { decisionId: string; decisionStressTest: { status: string } };
          confirmationToken: string;
        };
      };
      expect(decisionResponse.status).toBe(200);
      expect(decisionBody.data.decision.decisionStressTest.status).toBe('available');

      const confirmResponse = await fetch(
        `${baseUrl}/api/execution/decisions/${decisionBody.data.decision.decisionId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationToken: decisionBody.data.confirmationToken }),
        },
      );
      expect(confirmResponse.status).toBe(200);
      expect(
        (await confirmResponse.json()) as {
          data: { result: { decision: { executionStatus: string } } };
        },
      ).toMatchObject({
        data: { result: { decision: { executionStatus: 'execution_unavailable' } } },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('serves a read-only, source-grounded workspace research answer', async () => {
    const snapshots = new InMemorySnapshotStore();
    const executionStore = new InMemoryExecutionStore();
    let calls = 0;
    let observedFacts: Array<{ id: string; summary: string }> = [];
    const assistant: WorkspaceQuestionClient = {
      model: 'qwen3.8-max',
      askWorkspaceQuestion: async (input) => {
        calls += 1;
        observedFacts = input.facts;
        const asksAboutLiquidity = /liquidity|exit/i.test(input.question);
        if (/poem/i.test(input.question)) {
          return {
            content: JSON.stringify({
              status: 'out_of_scope',
              topic: 'general_context',
              answer: 'That is outside this instrument context.',
              supportingFactIds: [],
              uncertainties: [],
              model: 'qwen3.8-max',
              promptVersion: 'workspace-question-v2',
            }),
            providerReportedModel: 'qwen3.8-max',
          } as QwenCall;
        }
        return {
          content: JSON.stringify({
            status: asksAboutLiquidity ? 'answered' : 'insufficient_evidence',
            topic: asksAboutLiquidity ? 'liquidity' : 'evidence',
            answer: asksAboutLiquidity
              ? 'The observed book and exit simulation provide the available liquidity context.'
              : 'No verified source event is available to attribute this move.',
            supportingFactIds: asksAboutLiquidity
              ? ['liquidity_condition', 'exit_fill_ratio']
              : ['event_status'],
            uncertainties: asksAboutLiquidity
              ? ['The observed book can change before a later review.']
              : ['The source event record is unavailable in this context.'],
            model: 'qwen3.8-max',
            promptVersion: 'workspace-question-v2',
          }),
          providerReportedModel: 'qwen3.8-max',
        } as QwenCall;
      },
    };
    const server = createApiServer({
      marketData: testProvider(),
      snapshots,
      executionStore,
      assistant,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const response = await fetch(`${baseUrl}/api/assistant/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'RMUUSDT',
          question: 'What verified evidence explains this move?',
        }),
      });
      const body = (await response.json()) as {
        data: {
          status: string;
          answer: string;
          attemptCount: number;
          supportingFactIds: string[];
          supportingFacts: Array<{ id: string; value: string | null }>;
          contextTimestamp: string;
          processedAt: string;
          marketObservedAt: string | null;
          marketFreshness: { state: string };
          sourceObservationTimes: Array<{ sourceId: string; observedAt: string }>;
          inputHash: string;
          sources: unknown[];
        };
      };
      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        status: 'insufficient_evidence',
        supportingFactIds: ['event_status'],
        contextTimestamp: NOW.toISOString(),
        processedAt: NOW.toISOString(),
        attemptCount: 1,
        marketObservedAt: '2026-09-29T21:59:59.000Z',
        marketFreshness: { state: 'fresh' },
        sourceObservationTimes: [
          {
            sourceId: 'bitget_generic_spot_orderbook',
            observedAt: '2026-09-29T21:59:59.000Z',
          },
        ],
        inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(body.data.answer).not.toMatch(/\d/);
      expect(body.data.supportingFacts).toEqual([
        expect.objectContaining({ id: 'event_status', value: 'insufficient-event-evidence' }),
      ]);
      expect(body.data.sources.length).toBeGreaterThan(0);
      expect(observedFacts.find((fact) => fact.id === 'current_price')?.summary).toBe(
        'Current rToken price: 100.50',
      );
      expect(observedFacts.find((fact) => fact.id === 'event_status')?.summary).toContain(
        'insufficient-event-evidence',
      );
      expect(await executionStore.listPositions()).toHaveLength(0);
      expect(await executionStore.listAudit()).toHaveLength(0);

      const liquidity = await fetch(`${baseUrl}/api/assistant/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'RMUUSDT',
          question: 'What does the observed book say about exit liquidity?',
          quantity: '5',
        }),
      });
      const liquidityBody = (await liquidity.json()) as {
        data: {
          status: string;
          supportingFactIds: string[];
          supportingFacts: Array<{ id: string }>;
        };
      };
      expect(liquidity.status).toBe(200);
      expect(liquidityBody.data).toMatchObject({
        status: 'answered',
        attemptCount: 1,
        supportingFactIds: ['liquidity_condition', 'exit_fill_ratio'],
      });
      expect(liquidityBody.data.supportingFacts.map((fact) => fact.id)).toEqual([
        'liquidity_condition',
        'exit_fill_ratio',
      ]);

      const outOfScope = await fetch(`${baseUrl}/api/assistant/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', question: 'Write a poem about rain.' }),
      });
      expect(outOfScope.status).toBe(200);
      expect(((await outOfScope.json()) as { data: { status: string } }).data.status).toBe(
        'out_of_scope',
      );
      expect(calls).toBe(3);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  describe('assistant rate limiting', () => {
    async function withLimitedServer(
      limits: { perMinute: number; dailyCap: number },
      run: (
        ask: (headers?: Record<string, string>) => Promise<Response>,
        tick: (ms: number) => void,
      ) => Promise<void>,
    ): Promise<void> {
      let nowMs = NOW.getTime();
      const assistant: WorkspaceQuestionClient = {
        model: 'qwen3.8-max',
        askWorkspaceQuestion: async () =>
          ({
            content: JSON.stringify({
              status: 'insufficient_evidence',
              topic: 'evidence',
              answer: 'No verified source event is available.',
              supportingFactIds: ['event_status'],
              uncertainties: [],
              model: 'qwen3.8-max',
              promptVersion: 'workspace-question-v2',
            }),
            providerReportedModel: 'qwen3.8-max',
          }) as QwenCall,
      };
      const server = createApiServer({
        marketData: testProvider(),
        snapshots: new InMemorySnapshotStore(),
        executionStore: new InMemoryExecutionStore(),
        assistant,
        assistantRateLimit: limits,
        now: () => new Date(nowMs),
      });
      await listen(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      const ask = (headers: Record<string, string> = {}) =>
        fetch(`http://127.0.0.1:${address.port}/api/assistant/query`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ symbol: 'RMUUSDT', question: 'What evidence is available?' }),
        });
      try {
        await run(ask, (ms) => {
          nowMs += ms;
        });
      } finally {
        server.close();
        await once(server, 'close');
      }
    }

    it('limits each client per minute and recovers after the window', async () => {
      await withLimitedServer({ perMinute: 2, dailyCap: 100 }, async (ask, tick) => {
        expect((await ask({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' })).status).toBe(200);
        expect((await ask({ 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
        const limited = await ask({ 'x-forwarded-for': '1.1.1.1' });
        expect(limited.status).toBe(429);
        const body = (await limited.json()) as { data: null; error: { code: string } };
        expect(body.error.code).toBe('RATE_LIMITED');
        expect(body.data).toBeNull();
        expect((await ask({ 'x-forwarded-for': '2.2.2.2' })).status).toBe(200);
        tick(61_000);
        expect((await ask({ 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
      });
    });

    it('enforces the global daily cap across clients and resets at UTC midnight', async () => {
      await withLimitedServer({ perMinute: 10, dailyCap: 2 }, async (ask, tick) => {
        expect((await ask({ 'x-forwarded-for': '1.1.1.1' })).status).toBe(200);
        expect((await ask({ 'x-forwarded-for': '2.2.2.2' })).status).toBe(200);
        expect((await ask({ 'x-forwarded-for': '3.3.3.3' })).status).toBe(429);
        tick(2 * 60 * 60 * 1000);
        expect((await ask({ 'x-forwarded-for': '3.3.3.3' })).status).toBe(200);
      });
    });
  });

  it('rejects assistant snapshot and decision symbol mismatches before Qwen', async () => {
    const snapshots = new InMemorySnapshotStore();
    const assistant: WorkspaceQuestionClient = {
      model: 'qwen3.8-max',
      askWorkspaceQuestion: async () => {
        throw new Error('assistant should not be called for a mismatch');
      },
    };
    const qwen: DecisionStressTestClient = {
      model: 'qwen3.8-max',
      stressTestDecision: async () =>
        ({
          content: JSON.stringify({
            immediateExit: 'The book presents a trade-off.',
            evidence: 'The deterministic simulation is the evidence.',
            mainUncertainty: 'The next book is unknown.',
            considerations: ['Review the supplied facts.'],
            model: 'qwen3.8-max',
            promptVersion: 'decision-stress-test-v2',
          }),
          providerReportedModel: 'qwen3.8-max',
        }) as QwenCall,
    };
    const server = createApiServer({
      marketData: testProvider(),
      snapshots,
      qwen,
      assistant,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const orderBookResponse = await fetch(`${baseUrl}/api/instruments/RMUUSDT/orderbook`);
      const orderBookBody = (await orderBookResponse.json()) as {
        data: { snapshot: { snapshotId: string } };
      };
      const snapshotMismatch = await fetch(`${baseUrl}/api/assistant/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'OTHER',
          question: 'What does liquidity say about this exit?',
          snapshotId: orderBookBody.data.snapshot.snapshotId,
        }),
      });
      expect(snapshotMismatch.status).toBe(400);

      const positionResponse = await fetch(`${baseUrl}/api/execution/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5' }),
      });
      const positionBody = (await positionResponse.json()) as {
        data: { position: { positionId: string } };
      };
      const decisionResponse = await fetch(`${baseUrl}/api/execution/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          decision: 'hold',
          requestedQuantity: '5',
          simulationSnapshotId: orderBookBody.data.snapshot.snapshotId,
        }),
      });
      const decisionBody = (await decisionResponse.json()) as {
        data: { decision: { decisionId: string } };
      };
      const decisionMismatch = await fetch(`${baseUrl}/api/assistant/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'OTHER',
          question: 'What is the decision context?',
          decisionId: decisionBody.data.decision.decisionId,
        }),
      });
      expect(decisionMismatch.status).toBe(400);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('exposes a server-issued order-book snapshot and accepts only that snapshot ID for simulation', async () => {
    const snapshots = new InMemorySnapshotStore();
    const server = createApiServer({
      marketData: testProvider(),
      snapshots,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const orderBookResponse = await fetch(`${baseUrl}/api/instruments/RMUUSDT/orderbook`);
      expect(orderBookResponse.status).toBe(200);
      const orderBookBody = (await orderBookResponse.json()) as {
        mode: string;
        data: { snapshot: { snapshotId: string } };
        freshness: { state: string };
      };
      expect(orderBookBody.mode).toBe('LIVE');
      expect(orderBookBody.freshness.state).toBe('fresh');
      expect(orderBookBody.data.snapshot.snapshotId).toMatch(/^[a-f0-9]{64}$/);

      const simulationResponse = await fetch(`${baseUrl}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'RMUUSDT',
          requestedQuantity: '5',
          snapshotId: orderBookBody.data.snapshot.snapshotId,
        }),
      });
      expect(simulationResponse.status).toBe(200);
      const simulationBody = (await simulationResponse.json()) as {
        data: { filledQuantity: string; estimateDisclaimer: string };
      };
      expect(simulationBody.data.filledQuantity).toBe('5');
      expect(simulationBody.data.estimateDisclaimer).toBe(
        'observed-book-estimate-not-guaranteed-fill',
      );
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('returns normalized instrument context without exposing a browser-side provider path', async () => {
    const server = createApiServer({
      marketData: testProvider(),
      snapshots: new InMemorySnapshotStore(),
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }

    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/instruments/RMUUSDT/context`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          instrument: { providerSymbol: string; nativeTicker: string | null };
          session: { status: string };
          reference: { status: string };
          move: { status: string };
          market: { status: string };
          liquidityContext: { positionStatus: string };
          eventContext: { status: string };
          nativePriceConfirmation: { status: string };
          explanation: { headline: string };
        };
        sourceRefs: Array<{ url: string; label: string }>;
      };
      expect(body.data.instrument.providerSymbol).toBe('RMUUSDT');
      expect(body.data.instrument.nativeTicker).toBe('MU');
      expect(body.data.session.status).toBe('unavailable');
      expect(body.data.reference.status).toBe('unavailable');
      expect(body.data.move.status).toBe('unavailable');
      expect(body.data.market.status).toBe('available');
      expect(body.data.liquidityContext.positionStatus).toBe('position_required');
      expect(body.data.eventContext.status).toBe('insufficient-event-evidence');
      expect(body.data.nativePriceConfirmation.status).toBe('unavailable');
      expect(body.data.explanation.headline).toContain('context');
      expect(body.sourceRefs.every((ref) => ref.url.startsWith('https://'))).toBe(true);
      expect(body.sourceRefs.some((ref) => ref.label === 'Bitget Reality order book')).toBe(true);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects malformed simulation requests with a stable error code', async () => {
    const server = createApiServer({ marketData: testProvider(), now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }

    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', requestedQuantity: 5 }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INVALID_REQUEST');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('returns the product quantity error for a non-positive UI simulation quantity', async () => {
    const server = createApiServer({ marketData: testProvider(), now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '0' }),
      });
      expect(response.status).toBe(400);
      expect((await response.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'simulation_invalid_quantity' },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('exposes manual positions and requires Demo-only confirmation for external execution', async () => {
    const server = createApiServer({ marketData: testProvider(), now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const positionResponse = await fetch(`${baseUrl}/api/execution/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5' }),
      });
      expect(positionResponse.status).toBe(200);
      const positionBody = (await positionResponse.json()) as {
        data: { position: { positionId: string; environment: string; isSimulated: boolean } };
      };
      expect(positionBody.data.position.positionId).toMatch(/^[a-f0-9]{64}$/);
      expect(positionBody.data.position.environment).toBe('SIMULATED');
      expect(positionBody.data.position.isSimulated).toBe(true);

      const intentResponse = await fetch(`${baseUrl}/api/execution/intents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          orderType: 'market',
          requestedQuantity: '5',
        }),
      });
      expect(intentResponse.status).toBe(200);
      const intentBody = (await intentResponse.json()) as {
        data: { intent: { intentId: string; environment: string }; confirmationToken: string };
        sourceRefs: Array<{ snapshotId: string | null; providerSymbol: string | null }>;
      };
      expect(intentBody.data.intent.environment).toBe('SIMULATED');
      expect(intentBody.data.confirmationToken.length).toBeGreaterThan(20);
      expect(intentBody.sourceRefs).toHaveLength(1);
      expect(intentBody.sourceRefs[0]).toMatchObject({
        snapshotId: expect.any(String),
        providerSymbol: 'RMUUSDT',
      });

      const blockedResponse = await fetch(
        `${baseUrl}/api/execution/intents/${intentBody.data.intent.intentId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationToken: intentBody.data.confirmationToken }),
        },
      );
      expect(blockedResponse.status).toBe(400);
      expect((await blockedResponse.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'MANUAL_POSITION_NOT_EXECUTABLE' },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('records hold and exit decisions without turning manual simulation into a provider order', async () => {
    const snapshots = new InMemorySnapshotStore();
    const server = createApiServer({ marketData: testProvider(), snapshots, now: () => NOW });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const simulationResponse = await fetch(`${baseUrl}/api/execution/simulations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          symbol: 'RMUUSDT',
          quantity: '5',
          includeDecisionStressTest: true,
        }),
      });
      const simulationBody = (await simulationResponse.json()) as {
        data: { bookSnapshotId: string; decisionStressTest: { status: string } };
      };
      expect(simulationResponse.status).toBe(200);
      expect(simulationBody.data.bookSnapshotId).toMatch(/^[a-f0-9]{64}$/);
      expect(simulationBody.data.decisionStressTest.status).toBe('unavailable');

      const positionResponse = await fetch(`${baseUrl}/api/execution/positions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol: 'RMUUSDT', quantity: '5' }),
      });
      const positionBody = (await positionResponse.json()) as {
        data: { position: { positionId: string } };
      };

      const fullMismatch = await fetch(`${baseUrl}/api/execution/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          decision: 'full_exit',
          requestedQuantity: '2.5',
          orderType: 'market',
        }),
      });
      expect(fullMismatch.status).toBe(400);
      expect(
        (await fullMismatch.json()) as { error: { code: string; message: string } },
      ).toMatchObject({
        error: {
          code: 'DECISION_QUANTITY_MISMATCH',
          message: 'full_exit must use the entire available position quantity',
        },
      });

      const partialMismatch = await fetch(`${baseUrl}/api/execution/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          decision: 'partial_exit',
          requestedQuantity: '5',
          orderType: 'market',
        }),
      });
      expect(partialMismatch.status).toBe(400);
      expect(
        (await partialMismatch.json()) as { error: { code: string; message: string } },
      ).toMatchObject({
        error: {
          code: 'DECISION_QUANTITY_MISMATCH',
          message:
            'partial_exit must use a positive quantity smaller than the available position quantity',
        },
      });

      const holdResponse = await fetch(`${baseUrl}/api/execution/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          decision: 'hold',
          requestedQuantity: '5',
          simulationSnapshotId: simulationBody.data.bookSnapshotId,
        }),
      });
      const holdBody = (await holdResponse.json()) as {
        data: {
          decision: {
            decisionId: string;
            decision: string;
            simulation: { estimatedVWAP: string };
            executionStatus: string;
          };
          confirmationToken: string;
        };
      };
      expect(holdResponse.status).toBe(200);
      expect(holdBody.data.decision).toMatchObject({
        decision: 'hold',
        simulation: { estimatedVWAP: '100' },
        executionStatus: 'awaiting_confirmation',
      });
      const confirmedHold = await fetch(
        `${baseUrl}/api/execution/decisions/${holdBody.data.decision.decisionId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationToken: holdBody.data.confirmationToken }),
        },
      );
      const confirmedHoldBody = (await confirmedHold.json()) as {
        data: { result: { decision: { executionStatus: string }; order: unknown } };
      };
      expect(confirmedHold.status).toBe(200);
      expect(confirmedHoldBody.data.result).toMatchObject({
        decision: { executionStatus: 'not_applicable' },
        order: null,
      });
      const replayedHold = await fetch(
        `${baseUrl}/api/execution/decisions/${holdBody.data.decision.decisionId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationToken: holdBody.data.confirmationToken }),
        },
      );
      expect(replayedHold.status).toBe(409);
      expect((await replayedHold.json()) as { error: { code: string } }).toMatchObject({
        error: { code: 'CONFIRMATION_REUSED' },
      });

      const exitResponse = await fetch(`${baseUrl}/api/execution/decisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          positionId: positionBody.data.position.positionId,
          symbol: 'RMUUSDT',
          decision: 'partial_exit',
          requestedQuantity: '2.5',
          orderType: 'market',
        }),
      });
      const exitBody = (await exitResponse.json()) as {
        data: {
          decision: {
            decisionId: string;
            decision: string;
            requestedQuantity: string;
            simulation: { estimatedVWAP: string };
            executionStatus: string;
          };
          confirmationToken: string;
        };
      };
      expect(exitResponse.status).toBe(200);
      expect(exitBody.data.decision).toMatchObject({
        decision: 'partial_exit',
        requestedQuantity: '2.5',
        simulation: { estimatedVWAP: '100' },
        executionStatus: 'awaiting_confirmation',
      });
      const confirmedExit = await fetch(
        `${baseUrl}/api/execution/decisions/${exitBody.data.decision.decisionId}/confirm`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ confirmationToken: exitBody.data.confirmationToken }),
        },
      );
      const confirmedExitBody = (await confirmedExit.json()) as {
        data: { result: { decision: { executionStatus: string }; order: unknown } };
      };
      expect(confirmedExit.status).toBe(200);
      expect(confirmedExitBody.data.result).toMatchObject({
        decision: { executionStatus: 'execution_unavailable' },
        order: null,
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('exposes persisted source events and pending analysis without invoking Qwen', async () => {
    const eventStore = new InMemoryCaptureStore();
    const event = testEvent();
    await eventStore.saveSourceEvent(event);
    const server = createApiServer({
      marketData: testProvider(),
      eventStore,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const listResponse = await fetch(`${baseUrl}/api/instruments/RMUUSDT/events`);
      expect(listResponse.status).toBe(200);
      const listBody = (await listResponse.json()) as {
        data: {
          events: Array<{ kind: string; source: { label: string; url: string } }>;
          eventContext: { label: string; state: string };
        };
      };
      expect(listBody.data.events).toHaveLength(1);
      expect(listBody.data.eventContext.label).toBe('insufficient-event-evidence');
      expect(listBody.data.eventContext.state).toBe('unavailable');
      expect(listBody.data.events[0]).toMatchObject({
        kind: 'source-fact',
        source: { label: 'SEC EDGAR: API event fixture', url: event.sourceUrl },
      });

      const eventResponse = await fetch(`${baseUrl}/api/events/${event.eventId}`);
      expect(eventResponse.status).toBe(200);
      expect((await eventResponse.json()) as { data: { latestAnalysis: unknown } }).toMatchObject({
        data: { latestAnalysis: null },
      });

      const analysisResponse = await fetch(`${baseUrl}/api/events/${event.eventId}/analysis`);
      expect(analysisResponse.status).toBe(200);
      expect((await analysisResponse.json()) as { data: { status: string } }).toMatchObject({
        data: { status: 'pending' },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('exposes validated event evidence separately from source facts', async () => {
    const eventStore = new InMemoryCaptureStore();
    const event = testEvent();
    await eventStore.saveSourceEvent(event);
    await eventStore.saveEventAnalysis(testValidatedAnalysis(event.eventId));
    const server = createApiServer({
      marketData: testProvider(),
      eventStore,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/events/${event.eventId}/analysis`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          event: { kind: string };
          analysis: {
            kind: string;
            eventType: string;
            materiality: string;
            facts: unknown[];
            evidence: unknown[];
            model: string;
          };
          status: string;
        };
      };
      expect(body.data).toMatchObject({
        event: { kind: 'source-fact' },
        analysis: {
          kind: 'ai-interpretation',
          eventType: 'earnings',
          materiality: 'possibly_material',
          model: 'qwen3.8-max',
        },
        status: 'validated',
      });
      expect(body.data.analysis.facts).toHaveLength(1);
      expect(body.data.analysis.evidence).toHaveLength(1);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('serves replay metadata and simulations without invoking the provider', async () => {
    const captureStore = new InMemoryCaptureStore();
    const marketSnapshot = await captureStore.saveMarketSnapshot(testMarketSnapshotInput());
    const orderBookSnapshot = await captureStore.saveOrderBook(testSnapshot());
    const replayCase = await captureStore.saveReplayCase(
      createReplayCase({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        replayAsOf: NOW.toISOString(),
        marketSnapshot,
        orderBookSnapshot,
        marketStateSnapshot: null,
        manifestCreatedAt: '2026-09-30T00:00:00.000Z',
      }),
    );
    const provider = testProvider();
    const failIfCalled = async (): Promise<never> => {
      throw new Error('provider must not be called by replay routes');
    };
    provider.discoverRealityInstruments = failIfCalled;
    provider.getTicker = failIfCalled;
    provider.getOrderBook = failIfCalled;
    const server = createApiServer({
      marketData: provider,
      replayStore: captureStore,
      now: () => NOW,
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('test server did not expose a port');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const listResponse = await fetch(`${baseUrl}/api/replays`);
      expect(listResponse.status).toBe(200);
      expect(
        (await listResponse.json()) as { mode: string; data: { replays: unknown[] } },
      ).toMatchObject({
        mode: 'REPLAY',
        data: { replays: expect.any(Array) },
      });
      const caseResponse = await fetch(`${baseUrl}/api/replays/${replayCase.manifest.caseId}`);
      expect(caseResponse.status).toBe(200);
      const caseBody = (await caseResponse.json()) as {
        data: {
          manifest: { manifestHash: string };
          symbol: string;
          simulationAvailable: boolean;
        };
      };
      expect(caseBody.data.manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(caseBody.data.symbol).toBe('RMUUSDT');
      expect(caseBody.data.simulationAvailable).toBe(true);
      const simulationResponse = await fetch(
        `${baseUrl}/api/replays/${replayCase.manifest.caseId}/simulations`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requestedQuantity: '5' }),
        },
      );
      expect(simulationResponse.status).toBe(200);
      const simulationBody = (await simulationResponse.json()) as {
        mode: string;
        data: {
          simulation: { filledQuantity: string; condition: string };
          data: { simulation: { filledQuantity: string } };
        };
      };
      expect(simulationBody.mode).toBe('REPLAY');
      expect(simulationBody.data.simulation).toMatchObject({
        filledQuantity: '5',
        condition: 'execution-normal',
      });
      expect(simulationBody.data.data.simulation.filledQuantity).toBe('5');

      const contextResponse = await fetch(
        `${baseUrl}/api/replays/${replayCase.manifest.caseId}/context`,
      );
      expect(contextResponse.status).toBe(200);
      const contextBody = (await contextResponse.json()) as {
        mode: string;
        data: {
          mode: string;
          closeReference: { status: string };
          liquidity: { state: string };
        };
      };
      expect(contextBody.mode).toBe('REPLAY');
      expect(contextBody.data.mode).toBe('REPLAY');
      expect(contextBody.data.closeReference.status).toBe('unavailable');
      expect(contextBody.data.liquidity.state).toBe('available');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});

async function listen(server: ReturnType<typeof createApiServer>): Promise<void> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}

function testProvider(): PublicMarketDataProvider {
  const snapshot = testSnapshot();
  const orderBook: ProviderRecord<NormalizedOrderBook> = {
    source: TEST_FIXTURE_SOURCE,
    data: {
      providerSymbol: snapshot.providerSymbol,
      bids: snapshot.bids,
      asks: snapshot.asks,
      requestedDepth: snapshot.requestedDepth,
      returnedBidCount: snapshot.returnedBidCount,
      returnedAskCount: snapshot.returnedAskCount,
      providerTimestamp: snapshot.providerTimestamp,
      receivedAt: snapshot.receivedAt,
      source: TEST_FIXTURE_SOURCE,
    },
  };
  const instrument = {
    providerSymbol: 'RMUUSDT',
    baseCoin: 'rMU',
    quoteCoin: 'USDT',
    nativeTicker: 'MU',
    nativeName: null,
    mappingStatus: 'mapped' as const,
    isReality: true,
    isRwa: null,
    symbolType: 'stock',
    status: 'online',
    quantityPrecision: '5',
    pricePrecision: '2',
    quotePrecision: null,
    minOrderQty: '0.00001',
    minOrderAmount: '10',
    maxMarketOrderAmount: null,
    maxOrderQty: null,
    launchTime: null,
    maintainTime: null,
    tradingPeriod: null,
    weekendTradable: null,
    providerTimestamp: TEST_FIXTURE_SOURCE.providerTimestamp,
    receivedAt: TEST_FIXTURE_SOURCE.receivedAt,
    source: TEST_FIXTURE_SOURCE,
    mappingSource: TEST_FIXTURE_SOURCE,
  };
  const ticker = {
    providerSymbol: 'RMUUSDT',
    lastPrice: '100.5',
    bidPrice: '100',
    bidSize: '10',
    askPrice: '101',
    askSize: '10',
    baseVolume: '10',
    volume24h: '10',
    quoteVolume: '1005',
    usdtVolume: null,
    turnover24h: null,
    platformTurnover24h: null,
    turnoverObservations: {
      turnover24h: {
        value: null,
        providerField: 'turnover24h' as const,
        units: 'unknown' as const,
        sourceId: TEST_FIXTURE_SOURCE.sourceId,
        endpoint: TEST_FIXTURE_SOURCE.endpoint,
        safeForRanking: false as const,
        safeForClassification: false as const,
        note: 'test fixture',
      },
      platformTurnover24h: {
        value: null,
        providerField: 'platformTurnover24h' as const,
        units: 'unknown' as const,
        sourceId: TEST_FIXTURE_SOURCE.sourceId,
        endpoint: TEST_FIXTURE_SOURCE.endpoint,
        safeForRanking: false as const,
        safeForClassification: false as const,
        note: 'test fixture',
      },
    },
    providerTimestamp: TEST_FIXTURE_SOURCE.providerTimestamp,
    receivedAt: TEST_FIXTURE_SOURCE.receivedAt,
    source: TEST_FIXTURE_SOURCE,
  };
  return {
    discoverRealityInstruments: async () => ({ source: TEST_FIXTURE_SOURCE, data: [instrument] }),
    getTicker: async () => ({ source: TEST_FIXTURE_SOURCE, data: ticker }),
    getAllTickers: async () => ({ source: TEST_FIXTURE_SOURCE, data: [ticker] }),
    getOrderBook: async () => orderBook,
    getFills: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getCandles: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getHistoricalCandles: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getStockInfo: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getCompanyOverview: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketStates: async () => ({ source: TEST_FIXTURE_SOURCE, data: [] }),
    getMarketCalendar: async () => ({
      source: TEST_FIXTURE_SOURCE,
      data: { timeZone: 'UTC' },
    }),
  };
}

function testEvent(): SourceEvent {
  const rawContentHash = sha256('api event fixture');
  return {
    eventId: sha256(canonicalJson({ rawContentHash, externalId: 'api-event' })),
    providerSymbol: 'RMUUSDT',
    nativeTicker: 'MU',
    sourceType: 'test-fixture',
    sourceName: 'test source',
    sourceUrl: 'https://example.test/events/api-event',
    externalId: 'api-event',
    title: 'API event fixture',
    excerpt: 'The source reports a filing.',
    publishedAt: null,
    eventOccurredAt: null,
    sourceAvailableAt: '2026-09-29T20:01:00.000Z',
    retrievedAt: '2026-09-29T20:02:00.000Z',
    category: 'financial_event',
    rawContentHash,
    details: {},
  };
}

function testValidatedAnalysis(eventId: string): EventAnalysis {
  return {
    analysisId: sha256(`analysis-${eventId}`),
    eventId,
    model: 'qwen3.8-max',
    providerReportedModel: 'qwen3.8-max',
    thinkingMode: 'disabled',
    promptVersion: 'test-only',
    schemaVersion: 'test-only',
    eventType: 'earnings',
    entities: [],
    status: 'validated',
    materiality: 'possibly_material',
    facts: [
      {
        id: 'fact-1',
        statement: 'A source-bound test fact.',
        evidenceSpanIds: ['span-1'],
      },
    ],
    uncertainties: ['The fixture is not a production analysis.'],
    evidenceSpans: [
      {
        id: 'span-1',
        startOffset: 0,
        endOffset: 8,
        text: 'test fact',
        contentHash: 'a'.repeat(64),
      },
    ],
    confidence: 0.8,
    sourceBound: true,
    inputTokens: 10,
    reasoningTokens: 0,
    outputTokens: 5,
    totalTokens: 15,
    cacheTokens: 0,
    providerReportedCostUsd: null,
    estimatedCost: null,
    latencyMs: 10,
    processedAt: '2026-09-29T20:03:00.000Z',
    attemptCount: 1,
    retryReason: null,
    errorCode: null,
    validationIssues: [],
  };
}
