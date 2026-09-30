import { describe, expect, it } from 'vitest';
import { QWEN_ANALYSIS_PROMPT_VERSION } from '../src/adapters/qwen/index.js';
import {
  EventAnalysisService,
  buildEvidencePacket,
  buildQwenUsageLedger,
  validateEvidenceBinding,
} from '../src/domain/event-analysis.js';
import { buildDeterministicEvidenceSpans } from '../src/domain/event-evidence.js';
import { deduplicateSourceEvents, deriveEventContext } from '../src/domain/event-context.js';
import { evaluatePostCloseWindow } from '../src/domain/event-window.js';
import { canonicalJson } from '../src/lib/canonical.js';
import { ProbeError } from '../src/lib/errors.js';
import { sha256 } from '../src/lib/hash.js';
import { InMemoryCaptureStore } from '../src/persistence/store.js';
import type { QwenCall } from '../src/adapters/qwen/index.js';
import type { EventAnalysis, SourceEvent } from '../src/contracts/events.js';
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

  it('qualifies the real historical NVDA post-close timestamps', () => {
    const result = evaluatePostCloseWindow({
      event: { sourceAvailableAt: '2026-08-26T20:21:19.000Z' },
      contextAsOf: '2026-08-26T20:51:19.000Z',
      markets: MARKETS,
      calendar: CALENDAR,
    });
    expect(result.status).toBe('qualifies');
    expect(result.regularSessionClose).toBe('2026-08-26T20:00:00.000Z');
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

  it('builds stable application-owned spans with offsets and content hashes', () => {
    const excerpt =
      'Item 2.02 Results.\nThe filing reports quarterly results and annual guidance.\nThe source remains bounded.';
    const first = buildDeterministicEvidenceSpans(excerpt, 48);
    const second = buildDeterministicEvidenceSpans(excerpt, 48);

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(2);
    for (const span of first) {
      expect(span.text).toBe(excerpt.slice(span.startOffset, span.endOffset));
      expect(sha256(span.text)).toBe(span.contentHash);
    }
    expect(first.map((span) => span.id)).toEqual(first.map((_span, index) => `span-${index + 1}`));
  });

  it('accepts valid single-span and multi-span fact references', () => {
    const event = makeEvent('source-3', '2026-09-29T20:01:00.000Z');
    const singleSpanOutput = makeOutput([
      {
        id: 'fact-1',
        statement: 'The filing reports quarterly results.',
        evidenceSpanIds: ['span-1'],
        supportingQuote: 'quarterly results',
      },
    ]);
    expect(validateEvidenceBinding(buildEvidencePacket(event), singleSpanOutput)).toEqual([]);

    const multiSpanEvent = {
      ...event,
      excerpt: 'First sentence.\nSecond sentence.',
    };
    const multiSpanOutput = makeOutput([
      {
        id: 'fact-1',
        statement: 'The source contains two bounded statements.',
        evidenceSpanIds: ['span-1', 'span-2'],
      },
    ]);
    expect(validateEvidenceBinding(buildEvidencePacket(multiSpanEvent), multiSpanOutput)).toEqual(
      [],
    );
  });

  it('rejects unknown span IDs and supporting quotes outside referenced spans', () => {
    const event = makeEvent('binding-failures', '2026-09-29T20:01:00.000Z');
    const unknownIdIssues = validateEvidenceBinding(
      buildEvidencePacket(event),
      makeOutput([
        { id: 'fact-unknown', statement: 'Unknown.', evidenceSpanIds: ['span-unknown'] },
      ]),
    );
    expect(unknownIdIssues).toContainEqual({
      code: 'fact_evidence_span_missing',
      detail: 'fact-unknown:span-unknown',
    });

    const quoteIssues = validateEvidenceBinding(
      buildEvidencePacket(event),
      makeOutput([
        {
          id: 'fact-quote',
          statement: 'The source contains a claim.',
          evidenceSpanIds: ['span-1'],
          supportingQuote: 'outside the bounded span',
        },
      ]),
    );
    expect(quoteIssues).toContainEqual({
      code: 'supporting_quote_not_in_referenced_span',
      detail: 'fact-quote',
    });
  });

  it('quarantines unsupported output without a semantic or repair retry', async () => {
    const event = makeEvent('source-3', '2026-09-29T20:01:00.000Z');
    const invalid = makeCall({
      facts: [{ id: 'fact-1', statement: 'Unsupported claim.', evidenceSpanIds: ['unknown'] }],
    });

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
    expect(analysis.evidenceSpans).toEqual(buildEvidencePacket(event).evidenceSpans);
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
      confidence: 0.9,
      sourceBound: true,
      model: 'qwen3.8-max',
      promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
    };
    const issues = validateEvidenceBinding(buildEvidencePacket(event), output as never);
    expect(issues.some((issue) => issue.code === 'supporting_quote_not_in_referenced_span')).toBe(
      true,
    );
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
    expect(first.schemaVersion).toBe('event-analysis-v3');
    expect(first.evidenceSpans[0]?.startOffset).toBe(0);
    expect(JSON.stringify(first)).not.toContain('chain_of_thought');
    expect(JSON.stringify(first)).not.toContain('reasoning_content');
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
    expect(analysis.evidenceSpans).toHaveLength(1);
    expect(analysis.validationIssues).toEqual(['authentication_invalid']);
  });

  it('preserves a prior quarantined analysis while creating a new schema-versioned record', async () => {
    const store = new InMemoryCaptureStore();
    const event = makeEvent('schema-migration', '2026-09-29T20:01:00.000Z');
    const legacy = makeLegacyQuarantinedAnalysis(event.eventId);
    await store.saveEventAnalysis(legacy);
    const service = new EventAnalysisService(store, {
      model: 'qwen3.8-max',
      analyzeEvidence: async () =>
        makeCall({
          facts: [
            {
              id: 'fact-1',
              statement: 'The filing reports quarterly results.',
              evidenceSpanIds: ['span-1'],
            },
          ],
        }),
    });

    const corrected = await service.analyze(event);
    expect(corrected.schemaVersion).toBe('event-analysis-v3');
    expect(corrected.status).toBe('validated');
    expect(await store.getEventAnalysis(legacy.analysisId)).toEqual(legacy);
    expect(await store.listEventAnalyses(event.eventId)).toHaveLength(2);
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
  facts: Array<{
    id: string;
    statement: string;
    evidenceSpanIds: string[];
    supportingQuote?: string;
  }>;
}): QwenCall {
  const content = JSON.stringify({
    eventType: 'earnings',
    entities: [{ name: 'Micron Technology', ticker: 'MU' }],
    materiality: 'possibly_material',
    facts: input.facts,
    uncertainties: [],
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
      reasoningTokens: null,
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
    thinkingMode: 'disabled',
  };
}

function makeOutput(
  facts: Array<{
    id: string;
    statement: string;
    evidenceSpanIds: string[];
    supportingQuote?: string;
  }>,
) {
  return {
    eventType: 'earnings',
    entities: [{ name: 'Micron Technology', ticker: 'MU' }],
    materiality: 'possibly_material' as const,
    facts,
    uncertainties: [],
    confidence: 0.8,
    sourceBound: true,
    model: 'qwen3.8-max',
    promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
  };
}

function makeLegacyQuarantinedAnalysis(eventId: string): EventAnalysis {
  return {
    analysisId: sha256('legacy-quarantined-analysis'),
    eventId,
    model: 'qwen3.8-max',
    providerReportedModel: 'qwen3.8-max',
    thinkingMode: 'disabled' as const,
    promptVersion: 'event-evidence-v2',
    schemaVersion: 'event-analysis-v2',
    eventType: 'earnings',
    entities: [],
    status: 'quarantined' as const,
    materiality: 'insufficient_evidence' as const,
    facts: [],
    uncertainties: ['legacy record'],
    evidenceSpans: [{ id: 'span-1', quote: 'quarterly results', start: null, end: null }],
    confidence: null,
    sourceBound: false,
    inputTokens: 1,
    reasoningTokens: null,
    outputTokens: 1,
    totalTokens: 2,
    cacheTokens: 0,
    providerReportedCostUsd: null,
    estimatedCost: null,
    latencyMs: 1,
    processedAt: '2026-09-29T20:02:00.000Z',
    attemptCount: 1,
    retryReason: null,
    errorCode: 'evidence_binding_failed',
    validationIssues: ['legacy'],
  } as unknown as EventAnalysis;
}
