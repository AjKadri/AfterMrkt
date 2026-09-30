import type { EventAnalysis, SourceEvent } from '../contracts/events.js';
import { evaluatePostCloseWindow, type EventWindowResult } from './event-window.js';

export type EventContextLabel =
  | 'event-supported'
  | 'no-checked-event-support'
  | 'insufficient-event-evidence'
  | 'analysis-pending';

export type EventContext = {
  label: EventContextLabel;
  reasons: string[];
  qualifyingEventIds: string[];
  pendingEventIds: string[];
  analysisIds: string[];
  checkedAt: string;
  windowResults: EventWindowResult[];
};

export function uncheckedEventContext(checkedAt: string): EventContext {
  return {
    label: 'no-checked-event-support',
    reasons: ['event source storage is not configured for this API instance'],
    qualifyingEventIds: [],
    pendingEventIds: [],
    analysisIds: [],
    checkedAt,
    windowResults: [],
  };
}

export function deduplicateSourceEvents(events: SourceEvent[]): SourceEvent[] {
  const seen = new Set<string>();
  const result: SourceEvent[] = [];
  for (const event of events) {
    const key = event.externalId
      ? `${event.sourceType}:${event.externalId}`
      : `${event.sourceType}:${event.sourceUrl}:${event.rawContentHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result;
}

export function deriveEventContext(input: {
  events: SourceEvent[];
  analyses: EventAnalysis[];
  contextAsOf: string;
  markets: Parameters<typeof evaluatePostCloseWindow>[0]['markets'];
  calendar: Parameters<typeof evaluatePostCloseWindow>[0]['calendar'];
  checkedAt?: string;
}): EventContext {
  const events = deduplicateSourceEvents(input.events);
  const windowResults = events.map((event) =>
    evaluatePostCloseWindow({
      event,
      contextAsOf: input.contextAsOf,
      markets: input.markets,
      calendar: input.calendar,
    }),
  );
  const qualifying = events.filter((_, index) => windowResults[index]?.status === 'qualifies');
  const analysesByEvent = new Map<string, EventAnalysis>();
  for (const analysis of input.analyses) analysesByEvent.set(analysis.eventId, analysis);
  const pending = qualifying.filter((event) => !analysesByEvent.has(event.eventId));
  const timeWindowUnavailable = windowResults.some(
    (result) => result.status === 'time_window_unavailable',
  );
  const qualifyingAnalyses = qualifying
    .map((event) => analysesByEvent.get(event.eventId))
    .filter((analysis): analysis is EventAnalysis => analysis !== undefined);
  const supported = qualifyingAnalyses.some(
    (analysis) =>
      analysis.status === 'validated' &&
      analysis.sourceBound &&
      (analysis.materiality === 'material' || analysis.materiality === 'possibly_material'),
  );
  const insufficient = qualifyingAnalyses.some(
    (analysis) =>
      analysis.status === 'quarantined' ||
      analysis.status === 'unavailable' ||
      analysis.materiality === 'insufficient_evidence' ||
      !analysis.sourceBound,
  );
  let label: EventContextLabel;
  let reasons: string[];
  if (pending.length > 0) {
    label = 'analysis-pending';
    reasons = ['one or more qualifying source events have no persisted analysis'];
  } else if (supported) {
    label = 'event-supported';
    reasons = ['at least one qualifying event has validated, source-bound materiality evidence'];
  } else if (insufficient || timeWindowUnavailable) {
    label = 'insufficient-event-evidence';
    reasons = timeWindowUnavailable
      ? ['post-close event timing could not be determined from provider calendar data']
      : ['qualifying event analysis is unavailable, quarantined, or insufficient'];
  } else {
    label = 'no-checked-event-support';
    reasons = ['no qualifying post-close event has been found for this context'];
  }
  return {
    label,
    reasons,
    qualifyingEventIds: qualifying.map((event) => event.eventId),
    pendingEventIds: pending.map((event) => event.eventId),
    analysisIds: qualifyingAnalyses.map((analysis) => analysis.analysisId),
    checkedAt: input.checkedAt ?? input.contextAsOf,
    windowResults,
  };
}
