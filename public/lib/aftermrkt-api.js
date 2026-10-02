/* global fetch */

const JSON_HEADERS = { accept: 'application/json' };

export class AfterMrktApiError extends Error {
  constructor(message, code = 'request_failed', status = 0) {
    super(message);
    this.name = 'AfterMrktApiError';
    this.code = code;
    this.status = status;
  }
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers ?? {}) },
  });
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    throw new AfterMrktApiError(
      'AfterMrkt returned an unreadable response.',
      'request_failed',
      response.status,
    );
  }
  if (!response.ok || envelope.error) {
    throw new AfterMrktApiError(
      userMessage(envelope.error?.code, envelope.error?.message),
      envelope.error?.code ?? 'request_failed',
      response.status,
    );
  }
  return envelope;
}

function userMessage(code, fallback) {
  const messages = {
    instrument_not_found: 'That instrument is unavailable.',
    market_data_unavailable: 'Live market data is unavailable.',
    market_data_stale: 'Market data needs refreshing.',
    session_unavailable: 'The market session schedule is unavailable.',
    event_evidence_unavailable: 'Event evidence is unavailable.',
    simulation_invalid_quantity: 'Enter a valid positive position quantity.',
    simulation_book_unavailable: 'The observed order book is unavailable for simulation.',
    replay_not_found: 'That replay is unavailable.',
    replay_unavailable: 'Replay data is unavailable.',
  };
  return messages[code] ?? fallback ?? 'The AfterMrkt request could not be completed.';
}

function jsonOptions(body) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const afterMrktApi = {
  getInstruments(limit = 12) {
    return request(`/api/instruments?limit=${encodeURIComponent(limit)}`);
  },
  getContext(symbol) {
    return request(`/api/instruments/${encodeURIComponent(symbol)}/context`);
  },
  getEvents(symbol) {
    return request(`/api/instruments/${encodeURIComponent(symbol)}/events`);
  },
  getEvent(eventId) {
    return request(`/api/events/${encodeURIComponent(eventId)}`);
  },
  getEventAnalysis(eventId) {
    return request(`/api/events/${encodeURIComponent(eventId)}/analysis`);
  },
  simulate(symbol, quantity) {
    return request('/api/execution/simulations', jsonOptions({ symbol, quantity }));
  },
  getReplays() {
    return request('/api/replays');
  },
  getReplay(caseId) {
    return request(`/api/replays/${encodeURIComponent(caseId)}`);
  },
  getReplayContext(caseId) {
    return request(`/api/replays/${encodeURIComponent(caseId)}/context`);
  },
  simulateReplay(caseId, quantity) {
    return request(
      `/api/replays/${encodeURIComponent(caseId)}/simulations`,
      jsonOptions({ quantity }),
    );
  },
};
