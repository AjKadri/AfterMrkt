import { describe, expect, it } from 'vitest';
import {
  QWEN_DECISION_STRESS_JSON_SCHEMA,
  QWEN_DECISION_STRESS_PROMPT_VERSION,
  QWEN_EVENT_JSON_SCHEMA,
  QWEN_WORKSPACE_QUESTION_JSON_SCHEMA,
  QwenClient,
  parseQwenDecisionStressTest,
  parseQwenEvent,
  parseQwenWorkspaceQuestion,
  QWEN_WORKSPACE_QUESTION_PROMPT_VERSION,
} from '../src/adapters/qwen/index.js';
import type { QwenCall } from '../src/adapters/qwen/index.js';
import { runDecisionStressTest } from '../src/domain/decision-stress-test.js';
import providerContract from './fixtures/qwen/provider-contract.json';
import thinkingComparison from './fixtures/qwen/thinking-comparison.json';

describe('Qwen event contract', () => {
  it('accepts a bounded source-bound event object', () => {
    const result = parseQwenEvent(
      JSON.stringify({
        eventType: 'earnings',
        entities: [{ name: 'Micron Technology', ticker: 'MU' }],
        materiality: 'possibly_material',
        facts: [
          {
            id: 'fact-1',
            statement: 'The source describes quarterly results.',
            evidenceSpanIds: ['span-1'],
            supportingQuote: 'quarterly results',
          },
        ],
        uncertainties: [],
        confidence: 0.8,
        sourceBound: true,
        model: 'qwen3.8-max',
        promptVersion: 'event-extraction-v1',
      }),
    );

    expect(result.sourceBound).toBe(true);
    expect(result.entities[0]?.ticker).toBe('MU');
  });

  it('rejects malformed model output for the caller to repair or quarantine', () => {
    expect(() => parseQwenEvent('```json\n{"eventType":"earnings"}\n```')).toThrow();
  });

  it('rejects a fact without a deterministic span reference', () => {
    expect(() =>
      parseQwenEvent(
        JSON.stringify({
          eventType: 'earnings',
          entities: [],
          materiality: 'insufficient_evidence',
          facts: [{ id: 'fact-1', statement: 'Unbound claim.', evidenceSpanIds: [] }],
          uncertainties: [],
          confidence: 0,
          sourceBound: false,
          model: 'qwen3.8-max',
          promptVersion: 'event-extraction-v1',
        }),
      ),
    ).toThrow();
  });

  it('rejects model-owned evidence spans and offsets', () => {
    expect(() =>
      parseQwenEvent(
        JSON.stringify({
          eventType: 'earnings',
          entities: [{ name: 'Micron Technology', ticker: 'MU' }],
          materiality: 'possibly_material',
          facts: [
            {
              id: 'fact-1',
              statement: 'The source describes quarterly results.',
              evidenceSpanIds: ['span-1'],
            },
          ],
          uncertainties: [],
          evidenceSpans: [{ id: 'span-1', quote: 'quarterly results', start: 1, end: 18 }],
          confidence: 0.8,
          sourceBound: true,
          model: 'qwen3.8-max',
          promptVersion: 'event-extraction-v1',
        }),
      ),
    ).toThrow();
  });

  it('keeps the authenticated provider fixture redacted and schema-first', () => {
    expect(providerContract.fixtureType).toBe('redacted-qwen-provider-contract');
    expect(providerContract.redaction.apiKey).toBe('omitted');
    expect(providerContract.redaction.rawResponse).toBe('omitted');
    expect(providerContract.calls.jsonSchema.localZodValidation).toBe(true);
    expect(providerContract.calls.jsonSchema.providerReportedModel).toBe('qwen3.8-max');
    expect(providerContract.calls.jsonObjectFallback.status).toBe('malformed_provider_data');
    expect(providerContract.calls.repair.status).toBe('request_timeout');
    expect(JSON.stringify(providerContract)).not.toContain('Bearer ');
    expect(QWEN_EVENT_JSON_SCHEMA.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(QWEN_EVENT_JSON_SCHEMA.schema).not.toHaveProperty('properties.evidenceSpans');
    expect(QWEN_EVENT_JSON_SCHEMA.schema).not.toHaveProperty(
      'required',
      expect.arrayContaining(['evidenceSpans']),
    );
  });

  it('records the redacted non-thinking comparison without provider secrets', () => {
    expect(thinkingComparison.providerDefault.status).toBe('request_timeout');
    expect(thinkingComparison.disabled.status).toBe('completed');
    expect(thinkingComparison.disabled.schemaValid).toBe(true);
    expect(thinkingComparison.disabled.providerReportedModel).toBe('qwen3.8-max');
    expect(thinkingComparison.redaction.apiKey).toBe('omitted');
    expect(JSON.stringify(thinkingComparison)).not.toContain('Bearer ');
  });

  it('defaults the client to the production JSON Schema response format', () => {
    const client = new QwenClient();
    expect(client.responseFormat.type).toBe('json_schema');
    expect(client.thinkingMode).toBe('disabled');
  });

  it('tells Qwen the exact model name to echo in the decision stress test', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({ model: 'qwen3.8-max', choices: [{ message: { content: '{}' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const client = new QwenClient({
        apiKey: 'test-fixture-key',
        baseUrl: 'https://example.test/v1',
        model: 'qwen3.8-max',
      });
      await client.stressTestDecision({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        moveSinceNativeClosePercent: null,
        sessionState: 'closed',
        sourceEventStatus: 'not_applicable',
        sourceEventFacts: [],
        spreadBps: '1',
        freshnessState: 'fresh',
        liquidityCondition: 'execution-normal',
        requestedQuantity: '5',
        filledQuantity: '5',
        unfilledQuantity: '0',
        fillRatioWithin50Bps: '1',
        estimatedVwap: '100',
        slippageBps: '1',
        estimatedFee: '0.05',
        netProceeds: '99.95',
        takerFeeRate: '5.0%',
        nativePriceConfirmation: 'unavailable',
        limitations: [],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    const messages = requestBodies[0]?.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain('Set model to exactly qwen3.8-max.');
  });

  it('sends an exact fact allow-list and bounded retry instruction for workspace questions', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'qwen3.8-max',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: 'answered',
                  topic: 'liquidity',
                  answer: 'The observed book is available as deterministic context.',
                  supportingFactIds: ['liquidity_condition'],
                  uncertainties: ['The book can change before review.'],
                  model: 'qwen3.8-max',
                  promptVersion: 'workspace-question-v2',
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const client = new QwenClient({
        apiKey: 'test-fixture-key',
        baseUrl: 'https://example.test/v1',
        timeoutMs: 1234,
      });
      await client.askWorkspaceQuestion({
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        configuredModel: 'qwen3.8-max',
        question: 'What does liquidity say about this exit?',
        contextAsOf: '2026-09-29T22:00:00.000Z',
        facts: [
          {
            id: 'liquidity_condition',
            label: 'Liquidity condition',
            status: 'available',
            summary: 'Liquidity condition: execution-normal',
          },
        ],
        retryInstruction: 'Rewrite as neutral research context.',
      });

      const body = requestBodies[0];
      const messages = body?.messages as Array<{ role: string; content: string }>;
      expect(messages[0]?.content).toContain('bounded validation retry');
      expect(messages[0]?.content).toContain('neutral research context');
      expect(messages[1]?.content).toContain('allowedSupportingFactIds');
      expect(messages[1]?.content).toContain('configuredModel');
      expect(messages[0]?.content).toContain('Set model to exactly qwen3.8-max');
      expect(messages[1]?.content).toContain('liquidity_condition');
      expect(body?.response_format).toEqual({
        type: 'json_schema',
        json_schema: QWEN_WORKSPACE_QUESTION_JSON_SCHEMA,
      });
      expect(QWEN_WORKSPACE_QUESTION_JSON_SCHEMA.schema).toMatchObject({
        properties: {
          answer: { maxLength: 500 },
          uncertainties: { items: { maxLength: 120 } },
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends explicit non-thinking mode and captures reasoning-token metadata', async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          model: 'qwen3.8-max',
          choices: [
            {
              message: {
                content: JSON.stringify({
                  eventType: 'earnings',
                  entities: [{ name: 'Micron Technology', ticker: 'MU' }],
                  materiality: 'possibly_material',
                  facts: [],
                  uncertainties: [],
                  confidence: 0.5,
                  sourceBound: true,
                  model: 'qwen3.8-max',
                  promptVersion: 'event-extraction-v1',
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 3,
            completion_tokens: 5,
            total_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    try {
      const disabled = new QwenClient({
        apiKey: 'test-fixture-key',
        baseUrl: 'https://example.test/v1',
        thinkingMode: 'disabled',
        timeoutMs: 1234,
      });
      const disabledCall = await disabled.extractEvent({
        sourceUrl: 'https://example.test/source',
        sourceText: 'The source reports quarterly results.',
        responseFormat: { type: 'json_schema', json_schema: QWEN_EVENT_JSON_SCHEMA },
      });
      const providerDefault = new QwenClient({
        apiKey: 'test-fixture-key',
        baseUrl: 'https://example.test/v1',
        thinkingMode: 'provider-default',
      });
      await providerDefault.extractEvent({
        sourceUrl: 'https://example.test/source',
        sourceText: 'The source reports quarterly results.',
        responseFormat: { type: 'json_schema', json_schema: QWEN_EVENT_JSON_SCHEMA },
      });

      expect(requestBodies[0]?.enable_thinking).toBe(false);
      expect(requestBodies[0]?.response_format).toEqual({
        type: 'json_schema',
        json_schema: QWEN_EVENT_JSON_SCHEMA,
      });
      expect(requestBodies[1]).not.toHaveProperty('enable_thinking');
      expect(disabledCall.thinkingMode).toBe('disabled');
      expect(disabledCall.accounting.reasoningTokens).toBe(2);
      expect(disabledCall.accounting.inputTokens).toBe(3);
      expect(disabledCall.accounting.outputTokens).toBe(5);
      expect(disabledCall.accounting.totalTokens).toBe(8);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('Qwen decision stress contract', () => {
  it('accepts trade-off language without giving the trader a direction', () => {
    const result = parseQwenDecisionStressTest(
      JSON.stringify({
        immediateExit: 'The observed depth may absorb only part of the requested amount.',
        evidence: 'The deterministic simulation shows a partial fill against the captured book.',
        mainUncertainty: 'The captured book may change before any later review.',
        considerations: [
          'A smaller decision reduces current book impact but leaves more exposure.',
          'Immediacy accepts the observed execution-quality trade-off.',
        ],
        model: 'qwen3.8-max',
        promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
      }),
    );

    expect(result.considerations).toHaveLength(2);
    expect(QWEN_DECISION_STRESS_JSON_SCHEMA.schema).not.toHaveProperty('properties.vwap');
    expect(QWEN_DECISION_STRESS_JSON_SCHEMA.schema).not.toHaveProperty('properties.orderPrice');
  });

  it('rejects a recommendation instead of allowing Qwen to make the final call', () => {
    expect(() =>
      parseQwenDecisionStressTest(
        JSON.stringify({
          immediateExit: 'You should sell now.',
          evidence: 'The book is thin.',
          mainUncertainty: 'The next book is unknown.',
          considerations: ['Use care.'],
          model: 'qwen3.8-max',
          promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
        }),
      ),
    ).toThrow(/recommendation/);
  });

  it.each([
    ['50%', 'immediateExit'],
    ['$100', 'evidence'],
    ['(50%)', 'mainUncertainty'],
    ['~50%', 'considerations'],
    ['+3.5%', 'evidence'],
    ['-12 bps', 'immediateExit'],
  ] as const)(
    'rejects numeric literal %s in %s so financial values stay deterministic',
    (numericLiteral, field) => {
      const payload: Record<string, unknown> = {
        immediateExit: 'The captured book contains a trade-off.',
        evidence: 'The deterministic simulation is the evidence.',
        mainUncertainty: 'The next book is unknown.',
        considerations: ['Review the supplied facts.'],
        model: 'qwen3.8-max',
        promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
      };
      payload[field] =
        field === 'considerations'
          ? [`The captured book contains ${numericLiteral}.`]
          : `The captured book contains ${numericLiteral}.`;
      expect(() => parseQwenDecisionStressTest(JSON.stringify(payload))).toThrow(/numeric claim/);
    },
  );

  it('rejects model provenance that does not match the configured client', async () => {
    const result = await runDecisionStressTest(
      {
        model: 'qwen3.8-max',
        stressTestDecision: async () =>
          ({
            content: JSON.stringify({
              immediateExit: 'The observed depth presents a trade-off.',
              evidence: 'The deterministic simulation is the evidence.',
              mainUncertainty: 'The next book is unknown.',
              considerations: ['Review the supplied facts.'],
              model: 'another-model',
              promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
            }),
            providerReportedModel: 'another-model',
          }) as QwenCall,
      },
      {
        providerSymbol: 'RMUUSDT',
        nativeTicker: 'MU',
        moveSinceNativeClosePercent: null,
        sessionState: 'unavailable',
        sourceEventStatus: 'not_applicable',
        sourceEventFacts: [],
        spreadBps: null,
        freshnessState: 'fresh',
        liquidityCondition: 'execution-normal',
        requestedQuantity: '5',
        filledQuantity: '5',
        unfilledQuantity: '0',
        fillRatioWithin50Bps: '1',
        estimatedVwap: '100',
        slippageBps: '0',
        estimatedFee: '0.05',
        netProceeds: '99.95',
        takerFeeRate: '5.0%',
        nativePriceConfirmation: 'unavailable',
        limitations: [],
        processedAt: '2026-09-29T22:00:00.000Z',
      },
    );
    expect(result).toMatchObject({
      status: 'unavailable',
      model: 'qwen3.8-max',
      providerReportedModel: null,
    });
  });
});

describe('Qwen workspace answer filters', () => {
  const workspaceAnswer = (answer: string) =>
    JSON.stringify({
      status: 'answered',
      topic: 'exit',
      answer,
      supportingFactIds: ['exit_fill_ratio'],
      uncertainties: [],
      model: 'qwen3.8-max',
      promptVersion: QWEN_WORKSPACE_QUESTION_PROMPT_VERSION,
    });

  it.each([
    'You should probably sell.',
    'Consider exiting before the open.',
    'It would be wise to reduce exposure.',
    'Selling the full position now looks like the prudent choice.',
    'A partial exit is the better option here.',
    'I would recommend a partial exit.',
    'A full exit is not recommended while the book is stale.',
  ])('rejects advice phrasing: %s', (sentence) => {
    expect(() => parseQwenWorkspaceQuestion(workspaceAnswer(sentence))).toThrow(
      /trading recommendation/,
    );
  });

  it.each([
    'A full exit would consume more of the observed book than a partial exit.',
    'Holding keeps the position exposed to the reopening price.',
    'AfterMrkt cannot recommend a trade or choose between these scenarios.',
  ])('allows neutral description: %s', (sentence) => {
    expect(parseQwenWorkspaceQuestion(workspaceAnswer(sentence)).answer).toBe(sentence);
  });

  it('rejects number words used as values', () => {
    expect(() =>
      parseQwenWorkspaceQuestion(
        workspaceAnswer('Roughly five percent of the position would go unfilled.'),
      ),
    ).toThrow(/ungrounded numeric claim/);
  });
});

describe('decision stress test validation and retry', () => {
  const packet = {
    providerSymbol: 'RMUUSDT',
    nativeTicker: 'MU',
    moveSinceNativeClosePercent: null,
    sessionState: 'unavailable',
    sourceEventStatus: 'not_applicable',
    sourceEventFacts: [],
    spreadBps: '2.82 bps',
    freshnessState: 'fresh',
    liquidityCondition: 'execution-normal',
    requestedQuantity: '5',
    filledQuantity: '5',
    unfilledQuantity: '0',
    fillRatioWithin50Bps: '100.0%',
    estimatedVwap: '100.00',
    slippageBps: '0.00 bps',
    estimatedFee: '0.25',
    netProceeds: '499.75',
    takerFeeRate: '0.1%',
    nativePriceConfirmation: 'unavailable',
    limitations: [],
    processedAt: '2026-09-29T22:00:00.000Z',
  };
  const answer = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      immediateExit: 'The observed depth absorbs the amount.',
      evidence: 'The spread is 2.82 bps and net proceeds are 499.75.',
      mainUncertainty: 'The next book is unknown.',
      considerations: ['The fee reduces net proceeds.'],
      model: 'qwen3.8-max',
      promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
      ...overrides,
    });
  const clientFor = (contents: string[], reported = 'qwen3.8-max') => {
    const calls: Array<{ retryInstruction?: string }> = [];
    return {
      calls,
      client: {
        model: 'qwen3.8-max',
        stressTestDecision: async (input: { retryInstruction?: string }) => {
          calls.push(input);
          return {
            content: contents[Math.min(calls.length - 1, contents.length - 1)],
            providerReportedModel: reported,
          } as QwenCall;
        },
      },
    };
  };

  it('accepts grounded numbers and rejects ungrounded ones with a safe reason', async () => {
    const good = clientFor([answer()]);
    expect((await runDecisionStressTest(good.client, packet)).status).toBe('available');
    const bad = clientFor([answer({ evidence: 'The spread is 9 bps.' })]);
    const result = await runDecisionStressTest(bad.client, packet);
    expect(result).toMatchObject({
      status: 'unavailable',
      reason:
        'Qwen decision stress testing is unavailable: the answer failed validation (ungrounded number).',
    });
    expect(bad.calls).toHaveLength(2);
  });

  it('retries once and succeeds, keeping the instruction out of the hash', async () => {
    const retrying = clientFor([answer({ evidence: 'x'.repeat(500) }), answer()]);
    const result = await runDecisionStressTest(retrying.client, packet);
    expect(result.status).toBe('available');
    expect(retrying.calls[1]?.retryInstruction).toMatch(/too long/);
    const direct = await runDecisionStressTest(clientFor([answer()]).client, packet);
    expect(result.inputHash).toBe(direct.inputHash);
  });

  it('reports over-length answers and does not retry model mismatches', async () => {
    const long = await runDecisionStressTest(
      clientFor([answer({ immediateExit: 'y'.repeat(400) })]).client,
      packet,
    );
    expect(long).toMatchObject({ reason: expect.stringContaining('(too long)') });
    const mismatch = clientFor([answer({ model: 'other' })]);
    const result = await runDecisionStressTest(mismatch.client, packet);
    expect(result).toMatchObject({ reason: expect.stringContaining('(model mismatch)') });
    expect(mismatch.calls).toHaveLength(1);
  });
});
