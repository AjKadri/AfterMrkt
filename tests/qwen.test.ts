import { describe, expect, it } from 'vitest';
import { parseQwenEvent } from '../src/adapters/qwen/index.js';

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
});
