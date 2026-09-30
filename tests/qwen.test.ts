import { describe, expect, it } from 'vitest';
import { QWEN_EVENT_JSON_SCHEMA, parseQwenEvent } from '../src/adapters/qwen/index.js';
import providerContract from './fixtures/qwen/provider-contract.json';

describe('Qwen event contract', () => {
  it('accepts a bounded source-bound event object', () => {
    const result = parseQwenEvent(
      JSON.stringify({
        eventType: 'earnings',
        entities: [{ name: 'Micron Technology', ticker: 'MU' }],
        materiality: 'medium',
        facts: ['The source describes quarterly results.'],
        uncertainties: [],
        evidenceSpans: [{ quote: 'quarterly results' }],
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

  it('accepts nullable evidence offsets required by the structured-output schema', () => {
    const result = parseQwenEvent(
      JSON.stringify({
        eventType: 'earnings',
        entities: [{ name: 'Micron Technology', ticker: 'MU' }],
        materiality: 'medium',
        facts: ['The source describes quarterly results.'],
        uncertainties: [],
        evidenceSpans: [{ quote: 'quarterly results', start: null, end: null }],
        confidence: 0.8,
        sourceBound: true,
        model: 'qwen3.8-max',
        promptVersion: 'event-extraction-v1',
      }),
    );

    expect(result.evidenceSpans[0]?.start).toBeNull();
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
  });
});
