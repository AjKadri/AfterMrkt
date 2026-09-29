import type { Freshness, SourceMetadata } from './types.js';

export const DEFAULT_FRESHNESS_CONFIG = Object.freeze({
  // Provisional operational windows. They are not statistically validated.
  freshMaxAgeMs: 30_000,
  staleMaxAgeMs: 300_000,
  futureToleranceMs: 5_000,
});

export type FreshnessConfig = typeof DEFAULT_FRESHNESS_CONFIG;

export function assessFreshness(
  providerTimestamp: string | null,
  receivedAt: string | null,
  now = new Date(),
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): Freshness {
  const receivedMs = receivedAt === null ? null : Date.parse(receivedAt);
  const providerMs = providerTimestamp === null ? null : parseProviderTimestamp(providerTimestamp);
  const nowMs = now.getTime();

  if (receivedMs === null || !Number.isFinite(receivedMs)) {
    return {
      state: 'unavailable',
      reason: 'received timestamp is missing or invalid',
      ageMs: null,
      providerTimestamp,
      receivedAt,
    };
  }
  if (providerMs === null || !Number.isFinite(providerMs)) {
    return {
      state: 'unavailable',
      reason: 'provider timestamp is missing or invalid',
      ageMs: null,
      providerTimestamp,
      receivedAt,
    };
  }

  const ageMs = nowMs - providerMs;
  if (ageMs < -config.futureToleranceMs) {
    return {
      state: 'unavailable',
      reason: 'provider timestamp is too far in the future',
      ageMs,
      providerTimestamp,
      receivedAt,
    };
  }
  if (ageMs <= config.freshMaxAgeMs) {
    return {
      state: 'fresh',
      reason: 'provider timestamp is within the provisional fresh window',
      ageMs,
      providerTimestamp,
      receivedAt,
    };
  }
  if (ageMs <= config.staleMaxAgeMs) {
    return {
      state: 'stale',
      reason: 'provider timestamp exceeds the provisional fresh window',
      ageMs,
      providerTimestamp,
      receivedAt,
    };
  }
  return {
    state: 'unavailable',
    reason: 'provider timestamp exceeds the provisional stale window',
    ageMs,
    providerTimestamp,
    receivedAt,
  };
}

export function freshnessFromSource(
  source: SourceMetadata,
  now = new Date(),
  config: FreshnessConfig = DEFAULT_FRESHNESS_CONFIG,
): Freshness {
  return assessFreshness(source.providerTimestamp, source.receivedAt, now, config);
}

function parseProviderTimestamp(value: string): number | null {
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    return value.length <= 10 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
