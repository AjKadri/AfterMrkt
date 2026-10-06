import { describe, expect, it } from 'vitest';
import {
  QWEN_DECISION_STRESS_JSON_SCHEMA,
  QWEN_DECISION_STRESS_PROMPT_VERSION,
  QWEN_EVENT_JSON_SCHEMA,
  QwenClient,
  parseQwenDecisionStressTest,
  parseQwenEvent,
} from '../src/adapters/qwen/index.js';
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
});
