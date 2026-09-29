import { describe, expect, it } from 'vitest';
import { assessFreshness } from '../src/domain/freshness.js';

const NOW = new Date('2026-09-29T22:00:00.000Z');

describe('market freshness', () => {
  it('distinguishes fresh, stale, and unavailable data with provisional windows', () => {
    expect(assessFreshness('1790719199000', NOW.toISOString(), NOW).state).toBe('fresh');
    expect(assessFreshness('1790719139000', NOW.toISOString(), NOW).state).toBe('stale');
    expect(assessFreshness('1790718799000', NOW.toISOString(), NOW).state).toBe('unavailable');
  });

  it('does not treat a missing or invalid provider timestamp as current', () => {
    expect(assessFreshness(null, NOW.toISOString(), NOW).state).toBe('unavailable');
    expect(assessFreshness('not-a-timestamp', NOW.toISOString(), NOW).state).toBe('unavailable');
  });
});
