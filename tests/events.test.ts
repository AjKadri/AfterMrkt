import { describe, expect, it } from 'vitest';
import { QWEN_ANALYSIS_PROMPT_VERSION } from '../src/adapters/qwen/index.js';
import {
  EventAnalysisService,
  buildQwenUsageLedger,
  validateEvidenceBinding,
} from '../src/domain/event-analysis.js';
import { deduplicateSourceEvents, deriveEventContext } from '../src/domain/event-context.js';
import { evaluatePostCloseWindow } from '../src/domain/event-window.js';
import { canonicalJson } from '../src/lib/canonical.js';
import { ProbeError } from '../src/lib/errors.js';
import { sha256 } from '../src/lib/hash.js';
import { InMemoryCaptureStore } from '../src/persistence/store.js';
import type { QwenCall } from '../src/adapters/qwen/index.js';
import type { SourceEvent } from '../src/contracts/events.js';
import promptInjectionFixture from './fixtures/events/prompt-injection.json';

const MARKETS = [
  {
    market: 'US',
    stateList: [{ state: 'regular', startTime: '09:30:00', endTime: '16:00:00', timeZone: 'EST' }],
  },
];
const CALENDAR = {
  timeZone: 'EST',
  regularConfig: ['SATURDAY', 'SUNDAY'],
  specificConfig: [],
};

describe('event evidence pipeline', () => {
  it('applies the native post-close window with an exclusive close boundary', () => {
    const close = evaluatePostCloseWindow({
      event: { sourceAvailableAt: '2026-09-29T20:00:00.000Z' },
      contextAsOf: '2026-09-29T22:00:00.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
    });
    const afterClose = evaluatePostCloseWindow({
      event: { sourceAvailableAt: '2026-09-29T20:01:00.000Z' },
      contextAsOf: '2026-09-29T22:00:00.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
    });
    const future = evaluatePostCloseWindow({
      event: { sourceAvailableAt: '2026-09-29T22:01:00.000Z' },
      contextAsOf: '2026-09-29T22:00:00.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
    });

    expect(close.status).toBe('not_post_close');
    expect(afterClose.status).toBe('qualifies');
    expect(afterClose.regularSessionClose).toBe('2026-09-29T20:00:00.000Z');
    expect(future.status).toBe('future_source');
  });

  it('returns time_window_unavailable when provider calendar evidence is incomplete', () => {
    const result = evaluatePostCloseWindow({
      event: { sourceAvailableAt: '2026-09-29T20:01:00.000Z' },
      contextAsOf: '2026-09-29T22:00:00.000Z',
      markets: null,
      calendar: CALENDAR,
    });
    expect(result.status).toBe('time_window_unavailable');
  });

  it('deduplicates source identity before analysis', () => {
    const first = makeEvent('source-1', '2026-09-29T20:01:00.000Z');
    const duplicate = { ...first, retrievedAt: '2026-09-29T20:02:00.000Z' };
    const second = makeEvent('source-2', '2026-09-29T20:03:00.000Z');
    expect(deduplicateSourceEvents([first, duplicate, second])).toHaveLength(2);
  });

  it('keeps a source event immutable while making repeated retrieval idempotent', async () => {
    const store = new InMemoryCaptureStore();
    const first = makeEvent('source-immutable', '2026-09-29T20:01:00.000Z');
    const reread = { ...first, retrievedAt: '2026-09-30T20:01:00.000Z' };
    const savedFirst = await store.saveSourceEvent(first);
    const savedSecond = await store.saveSourceEvent(reread);
    expect(savedSecond).toEqual(savedFirst);
    expect(savedSecond.retrievedAt).toBe(first.retrievedAt);
    await expect(store.saveSourceEvent({ ...first, title: 'changed' })).rejects.toThrow(
      'immutable source event conflict',
    );
  });

  it('accepts only exact source-relative evidence and quarantines unsupported output', async () => {
    const event = makeEvent('source-3', '2026-09-29T20:01:00.000Z');
    const valid = makeCall({
      evidenceSpans: [{ id: 'span-1', quote: 'quarterly results', start: null, end: null }],
      facts: [
        {
          id: 'fact-1',
          statement: 'The filing reports quarterly results.',
          evidenceSpanIds: ['span-1'],
        },
      ],
    });
    const invalid = makeCall({
      evidenceSpans: [{ id: 'span-1', quote: 'unsupported claim', start: null, end: null }],
      facts: [{ id: 'fact-1', statement: 'Unsupported claim.', evidenceSpanIds: ['span-1'] }],
    });
    expect(validateEvidenceBinding(event, JSON.parse(valid.content) as never)).toEqual([]);

    let calls = 0;
    const service = new EventAnalysisService(new InMemoryCaptureStore(), {
      model: 'qwen3.8-max',
      analyzeEvidence: async () => {
        calls += 1;
        return invalid;
      },
    });
    const analysis = await service.analyze(event);
    expect(analysis.status).toBe('quarantined');
    expect(analysis.errorCode).toBe('evidence_binding_failed');
    expect(calls).toBe(1);
    expect(buildQwenUsageLedger([analysis]).analysisCount).toBe(1);
  });

  it('rejects an adversarial prompt-injection-shaped claim that is absent from the source', () => {
    const event = {
      ...makeEvent('prompt-injection', '2026-09-29T20:01:00.000Z'),
      excerpt: promptInjectionFixture.excerpt,
    };
    const output = {
      eventType: 'financial_event',
      entities: [{ name: 'Micron Technology', ticker: 'MU' }],
      materiality: 'possibly_material',
      facts: promptInjectionFixture.modelOutput.facts,
      uncertainties: [],
      evidenceSpans: promptInjectionFixture.modelOutput.evidenceSpans,
      confidence: 0.9,
      sourceBound: true,
      model: 'qwen3.8-max',
      promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
    };
    const issues = validateEvidenceBinding(event, output as never);
    expect(issues.some((issue) => issue.code === 'evidence_quote_not_found')).toBe(true);
  });

  it('retries one transient failure and then caches the immutable result', async () => {
    const event = makeEvent('source-4', '2026-09-29T20:01:00.000Z');
    let calls = 0;
    const service = new EventAnalysisService(new InMemoryCaptureStore(), {
      model: 'qwen3.8-max',
      analyzeEvidence: async () => {
        calls += 1;
        if (calls === 1) throw new ProbeError('request_timeout', 'fixture timeout');
        return makeCall({
          evidenceSpans: [{ id: 'span-1', quote: 'quarterly results', start: null, end: null }],
          facts: [
            {
              id: 'fact-1',
              statement: 'The filing reports quarterly results.',
              evidenceSpanIds: ['span-1'],
            },
          ],
        });
      },
    });
    const first = await service.analyze(event);
    const second = await service.analyze(event);
    expect(first.status).toBe('validated');
    expect(first.attemptCount).toBe(2);
    expect(first.retryReason).toBe('request_timeout');
    expect(second.analysisId).toBe(first.analysisId);
    expect(calls).toBe(2);
    expect(first.promptVersion).toBe(QWEN_ANALYSIS_PROMPT_VERSION);
  });

  it('persists a structured unavailable record for a non-transient provider error', async () => {
    const event = makeEvent('source-unavailable', '2026-09-29T20:01:00.000Z');
    const service = new EventAnalysisService(new InMemoryCaptureStore(), {
      model: 'qwen3.8-max',
      analyzeEvidence: async () => {
        throw new ProbeError('authentication_invalid', 'fixture authentication failure');
      },
    });
    const analysis = await service.analyze(event);
    expect(analysis.status).toBe('unavailable');
    expect(analysis.attemptCount).toBe(1);
    expect(analysis.validationIssues).toEqual(['authentication_invalid']);
  });

  it('labels qualifying events as pending until analysis exists', () => {
    const event = makeEvent('source-5', '2026-09-29T20:01:00.000Z');
    const context = deriveEventContext({
      events: [event],
      analyses: [],
      contextAsOf: '2026-09-29T22:00:00.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
    });
    expect(context.label).toBe('analysis-pending');
    expect(context.qualifyingEventIds).toEqual([event.eventId]);
  });
});

function makeEvent(externalId: string, sourceAvailableAt: string): SourceEvent {
  const excerpt = 'The filing reports quarterly results.';
  const rawContentHash = sha256(excerpt);
  return {
    eventId: sha256(canonicalJson({ externalId, rawContentHash })),
    providerSymbol: 'RMUUSDT',
    nativeTicker: 'MU',
    sourceType: 'test-fixture',
    sourceName: 'test source',
    sourceUrl: `https://example.com/${externalId}`,
    externalId,
    title: 'Quarterly results',
    excerpt,
    publishedAt: null,
    eventOccurredAt: null,
    sourceAvailableAt,
    retrievedAt: sourceAvailableAt,
    category: 'financial_event',
    rawContentHash,
    details: {},
  };
}

function makeCall(input: {
  evidenceSpans: Array<{ id: string; quote: string; start: number | null; end: number | null }>;
  facts: Array<{ id: string; statement: string; evidenceSpanIds: string[] }>;
}): QwenCall {
  const content = JSON.stringify({
    eventType: 'earnings',
    entities: [{ name: 'Micron Technology', ticker: 'MU' }],
    materiality: 'possibly_material',
    facts: input.facts,
    uncertainties: [],
    evidenceSpans: input.evidenceSpans,
    confidence: 0.8,
    sourceBound: true,
    model: 'qwen3.8-max',
    promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
  });
  return {
    raw: {
      url: 'https://example.com/qwen',
      status: 200,
      headers: {},
      bodyText: '{}',
      receivedAt: '2026-09-29T20:02:00.000Z',
    },
    response: {},
    content,
    usage: null,
    accounting: {
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedTokens: 0,
      providerReportedCostUsd: null,
      estimatedCostUsd: null,
      pricingSource: 'unavailable',
    },
    latencyMs: 5,
    model: 'qwen3.8-max',
    providerReportedModel: 'qwen3.8-max',
  };
}
