/* global document, URLSearchParams, window */

import { afterMrktApi, AfterMrktApiError } from './lib/aftermrkt-api.js';

const page = document.body.dataset.page;
const state = {
  symbol: null,
  context: null,
  eventData: null,
  simulations: null,
  fullPositionSimulation: null,
  decisionSimulation: null,
  position: null,
  pendingDecision: null,
  decisionEnvelope: null,
  decisionToken: null,
  assistantAnswer: null,
  requestId: 0,
};
const MARKET_BELT_REFRESH_MS = 30_000;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function setText(selector, value) {
  const element = $(selector);
  if (element) element.textContent = value;
}

function formatDate(value, fallback = '--') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date) + ' UTC'
  );
}

function formatTime(value, fallback = '--') {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return (
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(date) + ' UTC'
  );
}

function formatMoney(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return `$${numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function formatMoneyForSummary(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return `$${numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatNumber(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function formatPercent(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return `${numeric >= 0 ? '+' : ''}${numeric.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}%`;
}

function formatBps(value, fallback = '--') {
  if (value === null || value === undefined || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return `${numeric.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 })} bps`;
}

function formatAge(freshness) {
  if (!freshness || freshness.state === 'unavailable') return 'unavailable';
  if (freshness.ageMs === null || freshness.ageMs === undefined) return freshness.state;
  const seconds = Math.max(0, Math.round(freshness.ageMs / 1000));
  if (seconds < 60) return `${seconds}s · ${freshness.state}`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s · ${freshness.state}`;
}

function errorText(error) {
  return error instanceof AfterMrktApiError
    ? error.message
    : 'The AfterMrkt server could not provide this section.';
}

function formatAssistantFact(fact) {
  if (fact.status === 'unavailable') return fact.reason ?? 'unavailable';
  if (fact.value === null || fact.value === '') return '--';
  if (fact.unit === 'price') return formatMoney(fact.value);
  if (fact.unit === 'quote') return formatMoney(fact.value);
  if (fact.unit === 'percent') return formatPercent(fact.value);
  if (fact.unit === 'ratio') {
    const ratio = Number(fact.value);
    return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : '--';
  }
  if (fact.unit === 'bps') return formatBps(fact.value);
  if (fact.unit === 'units') return formatNumber(fact.value);
  return fact.value;
}

function renderAssistantAnswer(answer) {
  const result = $('#assistant-result');
  if (!result) return;
  state.assistantAnswer = answer;
  if (!answer) {
    result.hidden = true;
    result.classList.remove('unavailable', 'out-of-scope');
    return;
  }
  result.hidden = false;
  result.classList.toggle('unavailable', answer.status === 'unavailable');
  result.classList.toggle('out-of-scope', answer.status === 'out_of_scope');
  setText('#assistant-status', `QWEN · ${answer.status.replaceAll('_', ' ')}`);
  setText('#assistant-answer', answer.answer);
  const facts = answer.supportingFacts ?? [];
  const grounding = $('#assistant-grounding');
  const list = $('#assistant-grounding-list');
  if (grounding && list) {
    grounding.hidden = facts.length === 0;
    list.replaceChildren(
      ...facts.map((fact) => {
        const item = document.createElement('li');
        item.textContent = `${fact.label} · ${formatAssistantFact(fact)}`;
        return item;
      }),
    );
  }
  const uncertainties = $('#assistant-uncertainties');
  if (uncertainties) {
    uncertainties.replaceChildren(
      ...(answer.uncertainties ?? []).map((uncertainty) => {
        const item = document.createElement('li');
        item.textContent = uncertainty;
        return item;
      }),
    );
    uncertainties.hidden = (answer.uncertainties ?? []).length === 0;
  }
  setText(
    '#assistant-provenance',
    `Qwen · ${answer.model} · processed ${formatTime(answer.processedAt)} · market observed ${formatTime(answer.marketObservedAt)} · freshness ${answer.marketFreshness?.state ?? 'unavailable'} · source observed ${formatTime(answer.sourceObservationTimes?.[0]?.observedAt)} · input ${answer.inputHash}`,
  );
}

async function askWorkspaceQuestion(question) {
  const trimmed = question.trim();
  if (!trimmed || !state.symbol) return;
  const requestId = state.requestId;
  const symbol = state.symbol;
  const button = $('#assistant-submit');
  const input = $('#assistant-question');
  if (button) {
    button.disabled = true;
    button.textContent = 'Researching…';
  }
  setText('#assistant-status', 'QWEN · reading the current context…');
  setText('#assistant-answer', '');
  try {
    const simulation = state.fullPositionSimulation;
    const decision = state.decisionEnvelope?.data?.decision;
    const response = await afterMrktApi.askWorkspace({
      symbol,
      question: trimmed,
      ...(simulation?.bookSnapshotId ? { snapshotId: simulation.bookSnapshotId } : {}),
      ...(simulation?.requestedQuantity ? { quantity: simulation.requestedQuantity } : {}),
      ...(decision?.decisionId ? { decisionId: decision.decisionId } : {}),
    });
    if (requestId !== state.requestId || symbol !== state.symbol) return;
    renderAssistantAnswer(response.data);
  } catch (error) {
    if (requestId !== state.requestId || symbol !== state.symbol) return;
    renderAssistantAnswer({
      status: 'unavailable',
      answer: errorText(error),
      supportingFacts: [],
      uncertainties: ['The contextual Qwen explanation could not be loaded.'],
      model: '--',
      contextTimestamp: new Date().toISOString(),
      inputHash: '--',
    });
  } finally {
    if (requestId === state.requestId && symbol === state.symbol) {
      if (button) {
        button.disabled = false;
        button.textContent = 'Ask AfterMrkt';
      }
      if (input) input.value = trimmed;
    }
  }
}

function createTickerItem(instrument, duplicate = false) {
  const item = document.createElement('span');
  item.className = 'ticker-item';
  if (duplicate) item.setAttribute('aria-hidden', 'true');

  const symbol = document.createElement('span');
  symbol.className = 'ticker-symbol';
  symbol.textContent = instrument.nativeTicker ?? instrument.providerSymbol;

  const price = document.createElement('span');
  price.className = 'ticker-price';
  price.textContent = formatMoney(instrument.lastPrice);

  const change = document.createElement('span');
  const numericChange = Number(instrument.moveSinceNativeClosePercent);
  change.className = 'ticker-change';
  if (Number.isFinite(numericChange) && numericChange < 0) change.classList.add('down');
  change.textContent = formatPercent(instrument.moveSinceNativeClosePercent, '—');

  const freshness = instrument.freshness?.state ?? 'unavailable';
  item.title = `${instrument.providerSymbol} · movement since U.S. regular close · ${freshness}`;
  item.setAttribute(
    'aria-label',
    `${instrument.providerSymbol}, ${price.textContent}; ${change.textContent} since U.S. regular close; data ${freshness}`,
  );
  item.append(symbol, price, change);
  return item;
}

function renderMarketBeltUnavailable(message) {
  const belt = $('.market-belt');
  const label = $('#market-belt-label');
  const track = $('#market-belt-track');
  if (!belt || !label || !track) return;

  label.textContent = 'LIVE · UNAVAILABLE';
  belt.setAttribute('aria-label', `Live rToken prices unavailable: ${message}`);
  belt.title = message;
  track.classList.add('is-static');
  const item = document.createElement('span');
  item.className = 'ticker-item ticker-message';
  item.textContent = 'Live prices unavailable';
  track.replaceChildren(item);
}

function renderMarketBelt(envelope) {
  const belt = $('.market-belt');
  const label = $('#market-belt-label');
  const track = $('#market-belt-track');
  if (!belt || !label || !track) return;

  const instruments = (envelope?.data?.instruments ?? []).filter(
    (instrument) =>
      instrument &&
      instrument.lastPrice !== null &&
      instrument.lastPrice !== undefined &&
      (instrument.nativeTicker || instrument.providerSymbol),
  );
  if (!instruments.length) {
    renderMarketBeltUnavailable('No live instrument prices were returned.');
    return;
  }

  const freshnessStates = new Set(instruments.map((instrument) => instrument.freshness?.state));
  const status = freshnessStates.has('fresh')
    ? 'LIVE · CLOSE MOVE'
    : freshnessStates.has('stale')
      ? 'STALE · CLOSE MOVE'
      : 'LIVE · UNAVAILABLE';
  label.textContent = status;
  belt.setAttribute(
    'aria-label',
    `${status} rToken prices and movement since the U.S. regular close`,
  );
  belt.removeAttribute('title');
  track.classList.toggle('is-static', status === 'LIVE · UNAVAILABLE');
  track.replaceChildren(
    ...instruments.map((instrument) => createTickerItem(instrument)),
    ...instruments.map((instrument) => createTickerItem(instrument, true)),
  );
}

async function refreshMarketBelt() {
  try {
    const envelope = await afterMrktApi.getInstruments(5);
    renderMarketBelt(envelope);
  } catch (error) {
    renderMarketBeltUnavailable(errorText(error));
  }
}

async function initMarketBelt() {
  await refreshMarketBelt();
  window.setInterval(() => void refreshMarketBelt(), MARKET_BELT_REFRESH_MS);
}

function setCoverage(selector, label, status) {
  const element = $(selector);
  if (!element) return;
  element.textContent = `${label} · ${status}`;
  element.classList.toggle('pending', status === 'pending');
  element.classList.toggle('unavailable', status === 'unavailable');
  element.classList.toggle('stale', status === 'stale');
}

function renderSelect(instruments, selectedSymbol) {
  const select = $('#instrument-select');
  if (!select) return;
  select.replaceChildren(
    ...instruments.map((instrument) => {
      const option = document.createElement('option');
      option.value = instrument.providerSymbol;
      option.textContent = `${instrument.nativeTicker ?? instrument.providerSymbol} · ${instrument.providerSymbol}`;
      option.selected = instrument.providerSymbol === selectedSymbol;
      return option;
    }),
  );
  select.disabled = instruments.length === 0;
}

function renderContext(envelope) {
  const context = envelope.data;
  state.context = context;
  const instrument = context.instrument;
  const native = instrument?.nativeTicker ?? instrument?.providerSymbol ?? 'Unavailable';
  const company = instrument?.companyName ?? native;
  const session = context.session;
  const move = context.moveSinceClose ?? context.move;
  const market = context.market;
  const liquidity = context.liquidity;
  const metrics = liquidity?.metrics;
  const mode = context.mode;

  setText('#context-status', '');
  const contextStatus = $('#context-status');
  if (contextStatus) {
    contextStatus.replaceChildren(
      Object.assign(document.createElement('strong'), {
        className: 'workspace-live',
        textContent: mode,
      }),
      document.createTextNode(
        ` · ${instrument?.providerSymbol ?? state.symbol} · context as of ${formatTime(context.asOf)}`,
      ),
    );
  }
  setText('#instrument-native', native);
  setText('#instrument-company', company);
  setText(
    '#instrument-provider',
    `${instrument?.providerSymbol ?? state.symbol} · exact Bitget providerSymbol`,
  );
  setText(
    '#session-status',
    session?.status === 'open'
      ? 'U.S. MARKET OPEN'
      : session?.status === 'closed'
        ? 'U.S. MARKET CLOSED'
        : 'U.S. SESSION UNAVAILABLE',
  );
  setText(
    '#session-detail',
    session?.nextRegularSessionOpen
      ? `Next open · ${formatDate(session.nextRegularSessionOpen)} · ${session.calendarStatus}`
      : (session?.reason ?? 'Next open unavailable'),
  );
  setText(
    '#workspace-intro-copy',
    `Trace ${native} through the move, the evidence, and the observed-book cost of exiting before the U.S. market reopens.`,
  );
  setText(
    '#timeline-close-label',
    `U.S. MARKET CLOSE · ${formatTime(session?.previousRegularSessionClose)}`,
  );
  setText('#timeline-open-label', `NEXT OPEN · ${formatTime(session?.nextRegularSessionOpen)}`);
  const timelineEvent = $('#timeline-event');
  const eventRef = context.eventContext?.events?.[0];
  if (timelineEvent) {
    timelineEvent.firstChild.textContent = eventRef ? eventRef.title : 'NO EVENT';
    const small = timelineEvent.querySelector('small');
    if (small) small.textContent = formatTime(eventRef?.sourceAvailableAt);
  }
  const timelineNow = $('#timeline-now');
  if (timelineNow) {
    const label = mode === 'REPLAY' ? 'REPLAY AS OF' : 'NOW';
    timelineNow.firstChild.textContent = label;
    const small = timelineNow.querySelector('small');
    if (small) small.textContent = formatTime(context.asOf);
  }
  setText(
    '#timeline-reference',
    `${formatMoney(context.closeReference?.price)} · rToken price at U.S. regular close`,
  );
  setText(
    '#timeline-move',
    `${formatPercent(move?.percentageMove)} · ${formatNumber(move?.basisPointMove)} bps · ${formatMoney(move?.currentRTokenPrice)} now`,
  );
  setText(
    '#move-summary',
    move?.status === 'available'
      ? `${instrument?.providerSymbol} is ${formatMoney(move.absoluteMove)} ${Number(move.absoluteMove) >= 0 ? 'above' : 'below'} its own U.S. regular-close reference.`
      : `Move unavailable: ${move?.reason ?? 'the rToken close reference is unavailable.'}`,
  );

  setText(
    '#evidence-summary',
    context.eventContext?.qualifyingEventCount
      ? `${context.eventContext.qualifyingEventCount} qualifying source event found. Analysis remains separately attributed.`
      : 'No qualifying source event was found in the checked post-close window.',
  );
  renderEventSummary(state.eventData, context);

  setText('#market-spread', formatBps(market?.spreadBps ?? metrics?.spreadBps));
  setText('#market-midpoint', formatMoney(market?.midpoint ?? metrics?.midpoint));
  const depth = metrics?.depth?.within50Bps?.notional;
  setText('#market-depth', depth ? `$${formatNumber(depth)}` : '--');
  setText(
    '#market-freshness',
    formatAge(market?.freshness ?? liquidity?.metrics?.freshness ?? envelope.freshness),
  );
  setText(
    '#market-book-asof',
    `Book · ${formatTime(liquidity?.source?.observedAt ?? market?.providerTimestamp)}`,
  );
  const condition = liquidity?.condition?.label ?? 'unavailable';
  setText(
    '#market-warning',
    `${condition}. ${liquidity?.reason ?? 'Use the exit corridor as an observed-book estimate, not a guaranteed fill.'}`,
  );
  setText(
    '#workspace-footnote',
    `${mode} context · ${formatDate(context.asOf)} · source provenance retained`,
  );
  setCoverage('#coverage-market', 'Market data', context.market?.state ?? 'unavailable');
  const analysisState = context.eventContext?.qualifyingEventCount
    ? (context.eventContext?.state ?? 'unavailable')
    : 'not_applicable';
  setCoverage('#coverage-analysis', 'Qwen analysis', analysisState);
  setCoverage(
    '#coverage-native',
    'Native confirmation',
    context.nativePriceConfirmation?.status ?? 'unavailable',
  );
  setCoverage('#coverage-liquidity', 'Liquidity', context.liquidity?.state ?? 'unavailable');
}

function renderEventSummary(eventEnvelope, context) {
  const event = eventEnvelope?.data?.events?.[0] ?? eventEnvelope?.data?.event ?? null;
  const eventRef = context.eventContext?.events?.[0];
  if (!event && !eventRef) {
    setText('#event-title', 'No qualifying source event available');
    setText(
      '#event-excerpt',
      context.eventContext?.reasons?.[0] ?? 'Source evidence is unavailable for this instrument.',
    );
    setText('#event-source', 'Source · unavailable');
    setText('#event-availability', 'Availability · unavailable');
    setText('#event-materiality', 'Materiality · unavailable');
    setText('#analysis-status', 'Qwen analysis · not applicable');
    const detail = $('#evidence-detail');
    if (detail) {
      detail.replaceChildren(
        document.createTextNode(
          'Qwen was not run because no qualifying source event was available in the checked post-close window.',
        ),
      );
    }
    return;
  }
  const sourceEvent = event ?? eventRef;
  setText('#event-title', sourceEvent.title ?? 'Source event');
  setText(
    '#event-excerpt',
    event?.excerpt ?? 'Source event is available. Expand for provenance and evidence spans.',
  );
  setText('#event-source', event?.source?.label ?? 'SEC EDGAR');
  setText(
    '#event-availability',
    `Available · ${formatTime(event?.sourceAvailableAt ?? sourceEvent.sourceAvailableAt)}`,
  );
  setText(
    '#event-materiality',
    `Materiality · ${event?.analysis?.materiality ?? sourceEvent.materiality ?? 'pending'}`,
  );
  const analysis = event?.analysis ?? null;
  const analysisStatus = analysis?.status ?? sourceEvent.analysisStatus ?? 'pending';
  setText(
    '#analysis-status',
    analysisStatus === 'unavailable'
      ? 'Qwen analysis · unavailable (no validated result)'
      : `Qwen analysis · ${analysisStatus}`,
  );
  const detail = $('#evidence-detail');
  if (detail && event) {
    detail.replaceChildren(
      document.createTextNode(
        analysisStatus === 'unavailable'
          ? 'Qwen did not produce a validated interpretation for this source event. The source fact remains separate.'
          : `${event.source?.label ?? 'Source'} · ${event.source?.url ?? 'URL unavailable'}`,
      ),
      document.createElement('br'),
      document.createTextNode(
        `Evidence spans: ${analysis?.evidence?.length ?? sourceEvent.facts?.length ?? 0}. Native-price confirmation remains ${state.context?.nativePriceConfirmation?.status ?? 'unavailable'}.`,
      ),
    );
  }
}

function bindWorkspaceActions() {
  $('#move-link')?.addEventListener('click', () =>
    $('#workspace-timeline')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  );
  $('#evidence-link')?.addEventListener('click', () =>
    $('#evidence')?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  );
  $('#exit-link')?.addEventListener('click', () => {
    $('#exit-lens')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    $('#position-quantity')?.focus();
  });
  $('#provenance-toggle')?.addEventListener('click', () => {
    const details = $('#provenance-details');
    const toggle = $('#provenance-toggle');
    if (!details || !toggle) return;
    details.textContent = state.context?.sources?.length
      ? state.context.sources.map((source) => `${source.label} · ${source.observedAt}`).join(' | ')
      : 'This view is assembled from the server-side context contract. No browser-to-provider request is made.';
    const open = details.hidden;
    details.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });
  $('#evidence-toggle')?.addEventListener('click', () => {
    const detail = $('#evidence-detail');
    const toggle = $('#evidence-toggle');
    if (!detail || !toggle) return;
    const open = detail.classList.toggle('is-open');
    detail.setAttribute('aria-hidden', String(!open));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open
      ? 'Hide evidence spans and source URL'
      : 'View evidence spans and source URL';
  });
  $('#instrument-select')?.addEventListener('change', (event) => loadWorkspace(event.target.value));
  $('#assistant-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void askWorkspaceQuestion($('#assistant-question')?.value ?? '');
  });
  $$('.assistant-example').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $('#assistant-question');
      const question = button.dataset.question ?? '';
      if (input) input.value = question;
      void askWorkspaceQuestion(question);
    });
  });
  $('#simulate-button')?.addEventListener('click', () =>
    runSimulationSuite($('#position-quantity')?.value ?? ''),
  );
  $$('.decision-choice').forEach((button) => {
    button.addEventListener('click', () => {
      const kind = button.dataset.decision;
      if (!kind || !state.fullPositionSimulation) return;
      state.pendingDecision = kind;
      state.decisionEnvelope = null;
      state.decisionToken = null;
      state.decisionSimulation = null;
      $$('.decision-choice').forEach((item) =>
        item.classList.toggle('is-selected', item === button),
      );
      const review = $('#decision-review');
      if (review) review.hidden = false;
      const fullPositionSimulation = state.fullPositionSimulation;
      const totalQuantity = fullPositionSimulation.requestedQuantity;
      const quantity = $('#decision-requested-quantity');
      if (quantity) quantity.value = decisionQuantityFor(kind, totalQuantity);
      setText(
        '#decision-status',
        kind === 'hold'
          ? 'Review the position context, then record your hold decision.'
          : 'Choose the exit quantity and order parameters, then review the exit.',
      );
      setText('#decision-result', '');
      renderDecisionRecord(
        {
          decision: kind,
          providerSymbol: state.symbol,
          requestedQuantity: quantity?.value ?? totalQuantity,
          exitPercentage: kind === 'hold' ? '0' : kind === 'full_exit' ? '1' : '0.5',
          currentPrice: fullPositionSimulation.currentPrice,
          environment: 'SIMULATED',
          executionStatus: 'awaiting_confirmation',
          simulation: {
            ...fullPositionSimulation,
            estimatedVWAP: fullPositionSimulation.estimatedVwap,
            totalExpectedProceeds: fullPositionSimulation.estimatedProceeds,
            slippageVersusMidpointBps: fullPositionSimulation.slippageBps,
            positionPercentageWithin50Bps: fullPositionSimulation.fillRatioWithin50Bps,
            condition: { label: fullPositionSimulation.condition },
            snapshotTimestamp: fullPositionSimulation.bookAsOf,
          },
          decisionStressTest: fullPositionSimulation.decisionStressTest,
        },
        { awaitingReview: true },
      );
    });
  });
  $('#decision-review-button')?.addEventListener('click', () => void reviewTraderDecision());
  $('#decision-confirm')?.addEventListener('click', () => void confirmTraderDecision());
  $('#decision-back')?.addEventListener('click', () => {
    state.pendingDecision = null;
    state.decisionEnvelope = null;
    state.decisionToken = null;
    state.decisionSimulation = null;
    const review = $('#decision-review');
    if (review) review.hidden = true;
    $$('.decision-choice').forEach((item) => item.classList.remove('is-selected'));
    setText('#decision-result', '');
  });
  $('#decision-order-type')?.addEventListener('change', (event) => {
    const limitWrap = $('#decision-limit-price-wrap');
    if (limitWrap) limitWrap.hidden = event.target.value !== 'limit';
  });
  $$('.workspace-preset').forEach((button) => {
    button.addEventListener('click', () => {
      const input = $('#position-quantity');
      if (!input) return;
      const quantity = scaleQuantity(input.value, button.dataset.fraction);
      if (quantity === null) {
        input.focus();
        setText('#market-warning', 'Enter the full position quantity before using a preset.');
        return;
      }
      input.value = quantity;
      $$('.workspace-preset').forEach((item) =>
        item.classList.toggle('is-active', item === button),
      );
      void runSimulationSuite(quantity);
    });
  });
}

function scaleQuantity(value, fraction) {
  if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const [whole, decimal = ''] = value.trim().split('.');
  const digits = BigInt(whole + decimal || '0');
  const denominator =
    fraction === '0.25' || fraction === '0.75' ? 4n : fraction === '0.5' ? 2n : 1n;
  const multiplier = fraction === '0.75' ? 3n : 1n;
  let numerator = digits * multiplier;
  let extraScale = 0;
  while (numerator % denominator !== 0n) {
    numerator *= 10n;
    extraScale += 1;
  }
  const scale = decimal.length + extraScale;
  const raw = (numerator / denominator).toString().padStart(scale + 1, '0');
  const split = raw.length - scale;
  const output = scale ? `${raw.slice(0, split)}.${raw.slice(split)}` : raw;
  return output.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function renderSimulation(simulations) {
  const [quarter, threeQuarter, full] = simulations;
  state.simulations = simulations;
  state.fullPositionSimulation = full ?? null;
  state.decisionSimulation = null;
  const rows = [
    ['25', quarter],
    ['75', threeQuarter],
    ['100', full],
  ];
  const currentPrice = full?.currentPrice ?? full?.midpoint;
  const current = $('[data-exit-price="current"]');
  if (current) current.textContent = formatMoney(currentPrice);
  rows.forEach(([key, result]) => {
    const price = result?.estimatedVwap ?? result?.bestBid ?? result?.currentPrice;
    const element = `[data-exit-price="${key}"]`;
    setText(element, formatMoney(price));
    const row = $(element)?.closest('.exit-corridor-row');
    const ratio = Number(result?.fillRatioWithin100Bps ?? 0);
    row
      ?.querySelector('.exit-corridor-line')
      ?.style.setProperty('--fill', `${Math.max(8, Math.min(97, ratio * 100))}%`);
  });
  setText('#exit-vwap', formatMoney(full?.estimatedVwap));
  setText('#exit-slippage', formatBps(full?.slippageBps));
  setText(
    '#exit-executable',
    full ? `${(Number(full.fillRatioWithin50Bps) * 100).toFixed(1)}%` : '--',
  );
  renderExitExplanation(full);
  const note = $('.exit-corridor-note');
  if (note && full)
    note.innerHTML = `Observed-book estimate, not guaranteed fill. ${formatNumber(full.unfilledQuantity, '0')} ${full.symbol} remains unfilled against the captured depth. The result is <strong>SIMULATED</strong>; live execution is disabled.`;
  renderDecisionPanel(full);
}

function renderExitExplanation(simulation) {
  const explanation = $('#exit-explanation');
  if (!explanation) return;
  explanation.replaceChildren();
  if (!simulation) {
    explanation.append(
      document.createTextNode(
        'Enter a quantity and run the simulation to see how much the observed bids could absorb.',
      ),
    );
    return;
  }
  const requested = formatNumber(simulation.requestedQuantity, '0');
  const filled = formatNumber(simulation.filledQuantity, '0');
  const unfilled = formatNumber(simulation.unfilledQuantity, '0');
  const unfilledAmount = Number(simulation.unfilledQuantity);
  const within50 = Number(simulation.fillRatioWithin50Bps);
  const within50Text = Number.isFinite(within50) ? `${(within50 * 100).toFixed(1)}%` : '--';
  const noFillReason =
    simulation.reasons?.[0]?.metric === 'bookAvailability'
      ? 'the captured order book had no executable two-sided market'
      : `the captured order book could not provide a fill (${simulation.reasons?.[0]?.detail ?? 'the book was unavailable'})`;
  const fillSentence = simulation.estimatedVwap
    ? `the visible buyers could buy about ${filled} units at an estimated average of ${formatMoneyForSummary(simulation.estimatedVwap)}.`
    : `the visible buyers could buy about ${filled} units, but no average sale price is available because ${noFillReason}.`;
  const depthLimit = simulation.reasons?.find((item) => item.metric === 'observedDepthLimit');
  const unfilledSentence =
    Number.isFinite(unfilledAmount) && unfilledAmount > 0
      ? depthLimit
        ? `${unfilled} units would remain unfilled within the observed depth, which was limited to ${depthLimit.value} bid levels; liquidity beyond them is unknown.`
        : `${unfilled} units would remain without a matching bid in this snapshot.`
      : 'The captured bids could absorb the full requested amount.';
  explanation.append(
    document.createTextNode(
      `For ${requested} units of ${simulation.symbol}, ${fillSentence} ${unfilledSentence} Only ${within50Text} of the requested amount could be sold within 0.50% of the midpoint. That is a simulated estimate, not a guaranteed fill.`,
    ),
  );
}

function renderDecisionStressTest(stressTest) {
  const container = $('#decision-stress');
  if (!container) return;
  container.classList.toggle('unavailable', stressTest?.status === 'unavailable');
  container.replaceChildren();
  const title = document.createElement('h4');
  title.textContent = 'Decision stress test';
  container.append(title);
  if (!stressTest || stressTest.status === 'unavailable') {
    const message = document.createElement('p');
    message.textContent =
      stressTest?.reason ?? 'Qwen decision stress testing is unavailable for this simulation.';
    container.append(message);
    return;
  }
  const immediate = document.createElement('p');
  immediate.textContent = `Immediate exit · ${stressTest.immediateExit}`;
  const evidence = document.createElement('p');
  evidence.textContent = `Evidence · ${stressTest.evidence}`;
  const uncertainty = document.createElement('p');
  uncertainty.textContent = `Main uncertainty · ${stressTest.mainUncertainty}`;
  const list = document.createElement('ul');
  stressTest.considerations.forEach((item) => {
    const row = document.createElement('li');
    row.textContent = item;
    list.append(row);
  });
  const provenance = document.createElement('p');
  provenance.textContent = `Qwen · ${stressTest.model} · ${formatTime(stressTest.processedAt)} · input ${stressTest.inputHash}`;
  container.append(immediate, evidence, uncertainty, list, provenance);
}

function renderDecisionPanel(simulation) {
  const panel = $('#trader-decision');
  if (!panel) return;
  panel.hidden = !simulation;
  if (!simulation) return;
  renderDecisionStressTest(simulation.decisionStressTest);
  $$('.decision-choice').forEach((button) => {
    button.disabled = false;
    button.classList.toggle('is-selected', button.dataset.decision === state.pendingDecision);
  });
}

function decisionQuantityFor(kind, totalQuantity) {
  return kind === 'partial_exit' ? scaleQuantity(totalQuantity, '0.5') : totalQuantity;
}

function renderDecisionRecord(decision, { awaitingReview = false } = {}) {
  const simulation = decision?.simulation;
  setText('#decision-symbol', decision?.providerSymbol ?? state.symbol ?? '--');
  setText('#decision-quantity', formatNumber(decision?.requestedQuantity));
  setText(
    '#decision-percentage',
    decision?.exitPercentage === undefined
      ? '--'
      : `${(Number(decision.exitPercentage) * 100).toFixed(1)}%`,
  );
  setText('#decision-current-price', formatMoney(decision?.currentPrice ?? simulation?.midpoint));
  setText('#decision-vwap', formatMoney(simulation?.estimatedVWAP ?? simulation?.estimatedVwap));
  setText(
    '#decision-proceeds',
    formatMoney(simulation?.totalExpectedProceeds ?? simulation?.estimatedProceeds),
  );
  setText(
    '#decision-slippage',
    formatBps(simulation?.slippageVersusMidpointBps ?? simulation?.slippageBps),
  );
  setText(
    '#decision-fill-ratio',
    simulation
      ? `${(Number(simulation.positionPercentageWithin50Bps ?? simulation.fillRatioWithin50Bps) * 100).toFixed(1)}%`
      : '--',
  );
  setText('#decision-liquidity', simulation?.condition?.label ?? simulation?.condition ?? '--');
  setText('#decision-book-time', formatTime(simulation?.snapshotTimestamp ?? simulation?.bookAsOf));
  setText('#decision-environment', decision?.environment ?? '--');
  setText('#decision-execution-status', decision?.executionStatus ?? '--');
  setText(
    '#decision-review-title',
    decision?.decision === 'hold'
      ? 'Review hold decision'
      : `Review ${decision?.decision === 'partial_exit' ? 'partial' : 'full'} exit`,
  );
  setText(
    '#decision-status',
    awaitingReview
      ? 'Review these deterministic values before creating a decision record.'
      : decision?.environment === 'SIMULATED'
        ? 'This confirmation records a paper decision. Provider execution is unavailable for manual positions.'
        : 'This decision remains pending explicit confirmation.',
  );
  const quantityInput = $('#decision-requested-quantity');
  if (quantityInput && decision?.requestedQuantity !== undefined)
    quantityInput.value = decision.requestedQuantity;
  const isHold = decision?.decision === 'hold';
  const reviewButton = $('#decision-review-button');
  const confirmButton = $('#decision-confirm');
  if (reviewButton) {
    reviewButton.hidden = !awaitingReview;
    reviewButton.textContent = isHold ? 'Review hold decision' : 'Review exit';
  }
  if (confirmButton) {
    confirmButton.hidden = awaitingReview;
    confirmButton.textContent = isHold ? 'Confirm hold' : 'Confirm exit';
  }
  [
    '#decision-requested-quantity',
    '#decision-order-type',
    '#decision-limit-price',
    '#decision-max-slippage',
  ].forEach((selector) => {
    const element = $(selector);
    if (element) element.disabled = !awaitingReview;
  });
  if (quantityInput) quantityInput.readOnly = decision?.decision !== 'partial_exit';
  const limitWrap = $('#decision-limit-price-wrap');
  if (limitWrap) limitWrap.hidden = $('#decision-order-type')?.value !== 'limit';
  const stressTest =
    decision?.decisionStressTest !== null &&
    decision?.decisionStressTest !== undefined &&
    decision?.decisionStressTestInputHash === decision.decisionStressTest.inputHash
      ? decision.decisionStressTest
      : null;
  renderDecisionStressTest(stressTest);
}

function simulationViewFromDecision(decision, previousSimulation) {
  const simulation = decision?.simulation;
  if (!simulation) return previousSimulation;
  return {
    ...(previousSimulation ?? {}),
    symbol: decision.providerSymbol,
    bookSnapshotId: decision.bookSnapshotId ?? simulation.snapshotId,
    currentPrice: decision.currentPrice,
    requestedQuantity: simulation.requestedQuantity,
    filledQuantity: simulation.filledQuantity,
    unfilledQuantity: simulation.unfilledQuantity,
    bestBid: simulation.bestBid,
    midpoint: simulation.midpoint,
    estimatedVwap: simulation.estimatedVWAP,
    estimatedProceeds: simulation.totalExpectedProceeds,
    absoluteSpread: simulation.absoluteSpread,
    spreadBps: simulation.spreadBps,
    slippageBps: simulation.slippageVersusMidpointBps,
    slippageVsBestBidBps: simulation.slippageVersusBestBidBps,
    levelsConsumed: simulation.levelsConsumed,
    executableWithin25Bps: simulation.quantityExecutableWithin25Bps,
    executableWithin50Bps: simulation.quantityExecutableWithin50Bps,
    fillRatioWithin25Bps: simulation.positionPercentageWithin25Bps,
    fillRatioWithin50Bps: simulation.positionPercentageWithin50Bps,
    condition: simulation.condition.label,
    reasons: simulation.reasons,
    bookAsOf: simulation.snapshotTimestamp,
    receivedAt: simulation.receivedTimestamp,
    freshness: simulation.freshness,
    decisionStressTest: null,
  };
}

async function ensureManualPosition(fullPositionSimulation) {
  const quantity = fullPositionSimulation.requestedQuantity;
  if (state.position?.providerSymbol === state.symbol && state.position.quantity === quantity) {
    return state.position;
  }
  const response = await afterMrktApi.createManualPosition(state.symbol, quantity);
  state.position = response.data.position;
  return state.position;
}

async function reviewTraderDecision() {
  const fullPositionSimulation = state.fullPositionSimulation;
  const kind = state.pendingDecision;
  if (!fullPositionSimulation || !kind) {
    setText(
      '#decision-status',
      'Run a successful simulation, then choose Hold, partial exit, or full exit.',
    );
    return;
  }
  const totalQuantity = fullPositionSimulation.requestedQuantity;
  const quantityInput = $('#decision-requested-quantity');
  const requestedQuantity = quantityInput?.value.trim() ?? totalQuantity;
  if (!/^\d+(?:\.\d+)?$/.test(requestedQuantity) || Number(requestedQuantity) <= 0) {
    setText('#decision-status', 'Enter a positive quantity before reviewing the decision.');
    quantityInput?.focus();
    return;
  }
  const reviewButton = $('#decision-review-button');
  if (reviewButton) {
    reviewButton.disabled = true;
    reviewButton.textContent = 'Preparing review…';
  }
  try {
    const position = await ensureManualPosition(fullPositionSimulation);
    const orderType = $('#decision-order-type')?.value ?? 'market';
    const limitPrice = $('#decision-limit-price')?.value.trim() ?? '';
    const maxSlippage = $('#decision-max-slippage')?.value.trim() ?? '';
    const response = await afterMrktApi.createDecision({
      positionId: position.positionId,
      symbol: state.symbol,
      decision: kind,
      requestedQuantity: kind === 'hold' ? totalQuantity : requestedQuantity,
      simulationSnapshotId: fullPositionSimulation.bookSnapshotId,
      ...(kind === 'hold' ? {} : { orderType }),
      ...(kind === 'hold' || orderType !== 'limit' || !limitPrice ? {} : { limitPrice }),
      ...(kind === 'hold' || !maxSlippage ? {} : { maximumAcceptableSlippageBps: maxSlippage }),
    });
    state.decisionEnvelope = response;
    state.decisionToken = response.data.confirmationToken;
    renderDecisionRecord(response.data.decision);
    setText('#decision-result', 'Decision ready. No order has been placed.');
  } catch (error) {
    setText('#decision-status', errorText(error));
  } finally {
    if (reviewButton) reviewButton.disabled = false;
  }
}

async function confirmTraderDecision() {
  const decision = state.decisionEnvelope?.data?.decision;
  if (!decision || !state.decisionToken) return;
  const button = $('#decision-confirm');
  if (button) {
    button.disabled = true;
    button.textContent = 'Confirming…';
  }
  try {
    const response = await afterMrktApi.confirmDecision(decision.decisionId, state.decisionToken);
    const result = response.data.result;
    if (result.status === 'refresh_required') {
      state.decisionSimulation = simulationViewFromDecision(
        result.decision,
        state.decisionSimulation ?? state.fullPositionSimulation,
      );
      state.decisionToken = result.confirmationToken;
      state.decisionEnvelope = {
        data: { decision: result.decision, confirmationToken: result.confirmationToken },
      };
      renderDecisionRecord(result.decision, { awaitingReview: false });
      setText(
        '#decision-status',
        'The book changed before confirmation. Review the refreshed deterministic values and confirm again.',
      );
      setText('#decision-result', 'NOT RECORDED YET · PRICES MOVED · REVIEW AND CONFIRM AGAIN');
      return;
    }
    state.decisionEnvelope = { data: { decision: result.decision } };
    renderDecisionRecord(result.decision, { awaitingReview: false });
    setText(
      '#decision-result',
      result.decision.executionStatus === 'execution_unavailable'
        ? 'PAPER DECISION RECORDED · EXECUTION UNAVAILABLE · NO ORDER CREATED'
        : result.decision.decision === 'hold'
          ? 'HOLD DECISION RECORDED · NO ORDER CREATED'
          : `DECISION CONFIRMED · ${String(result.decision.executionStatus).toUpperCase()}`,
    );
  } catch (error) {
    setText('#decision-status', errorText(error));
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = decision.decision === 'hold' ? 'Confirm hold' : 'Confirm exit';
    }
  }
}

async function runSimulationSuite(quantity) {
  if (!state.symbol || !/^\d+(?:\.\d+)?$/.test(quantity.trim()) || Number(quantity) <= 0) {
    setText('#market-warning', 'Enter a valid positive position quantity to run the simulation.');
    return;
  }
  const symbol = state.symbol;
  const requestId = state.requestId;
  const button = $('#simulate-button');
  if (button) {
    button.disabled = true;
    button.textContent = 'Simulating…';
  }
  try {
    const quantities = ['0.25', '0.75', '1'].map((fraction) => scaleQuantity(quantity, fraction));
    const results = await Promise.all(
      quantities.map((item, index) => afterMrktApi.simulate(symbol, item, index === 2)),
    );
    if (requestId !== state.requestId || state.symbol !== symbol) return;
    renderSimulation(results.map((result) => result.data));
    setText(
      '#market-warning',
      `Simulation complete against the observed book. ${results[2].data.condition}.`,
    );
  } catch (error) {
    if (requestId !== state.requestId || state.symbol !== symbol) return;
    setText('#market-warning', errorText(error));
  } finally {
    if (button && requestId === state.requestId && state.symbol === symbol) {
      button.disabled = false;
      button.textContent = 'Run exit simulation';
    }
  }
}

async function loadWorkspace(symbol) {
  const requestId = ++state.requestId;
  state.symbol = symbol;
  state.context = null;
  state.eventData = null;
  resetWorkspaceView(symbol);
  try {
    const [context, events] = await Promise.all([
      afterMrktApi.getContext(symbol),
      afterMrktApi.getEvents(symbol).catch(() => null),
    ]);
    if (requestId !== state.requestId) return;
    state.eventData = events;
    renderContext(context);
  } catch (error) {
    if (requestId !== state.requestId) return;
    setText('#context-status', errorText(error));
    setText('#market-warning', errorText(error));
    setCoverage('#coverage-market', 'Market data', 'unavailable');
  }
}

function resetWorkspaceView(symbol) {
  state.simulations = null;
  state.fullPositionSimulation = null;
  state.decisionSimulation = null;
  state.position = null;
  state.pendingDecision = null;
  state.decisionEnvelope = null;
  state.decisionToken = null;
  state.assistantAnswer = null;
  setText('#context-status', `Loading ${symbol} live context…`);
  setText('#instrument-native', 'Loading…');
  setText('#instrument-company', 'Loading…');
  setText('#instrument-provider', `${symbol} · exact Bitget providerSymbol`);
  setText('#session-status', 'Loading session…');
  setText('#session-detail', 'Loading next open…');
  setText('#timeline-close-label', 'U.S. MARKET CLOSE · --');
  setText('#timeline-open-label', 'NEXT OPEN · --');
  setText('#timeline-reference', 'rToken price at U.S. regular close · --');
  setText('#timeline-move', 'Loading move…');
  setText('#timeline-event', 'EVENT --');
  setText('#timeline-now', 'NOW --');
  setText('#move-summary', 'Loading move context…');
  setText('#evidence-summary', 'Loading source evidence…');
  setText('#event-title', 'Waiting for source evidence…');
  setText(
    '#event-excerpt',
    'The source fact and any later AI interpretation will appear here when the API returns them.',
  );
  setText('#event-source', 'Source · --');
  setText('#event-availability', 'Availability · --');
  setText('#event-materiality', 'Materiality · --');
  setText('#analysis-status', 'Qwen analysis · loading…');
  const evidenceDetail = $('#evidence-detail');
  if (evidenceDetail) {
    evidenceDetail.classList.remove('is-open');
    evidenceDetail.setAttribute('aria-hidden', 'true');
    evidenceDetail.textContent =
      'Source URL, evidence spans, native-confirmation state, and analysis provenance will appear here.';
  }
  const evidenceToggle = $('#evidence-toggle');
  if (evidenceToggle) {
    evidenceToggle.setAttribute('aria-expanded', 'false');
    evidenceToggle.textContent = 'View evidence spans and source URL';
  }
  setText('#market-spread', '--');
  setText('#market-midpoint', '--');
  setText('#market-depth', '--');
  setText('#market-freshness', '--');
  setText('#market-book-asof', 'Book · loading');
  setText('#market-warning', 'Loading observed-book quality…');
  setText('#workspace-footnote', 'Loading context provenance…');
  setCoverage('#coverage-market', 'Market data', 'pending');
  setCoverage('#coverage-analysis', 'Qwen analysis', 'pending');
  setCoverage('#coverage-native', 'Native confirmation', 'pending');
  setCoverage('#coverage-liquidity', 'Liquidity', 'pending');
  $$('[data-exit-price]').forEach((element) => {
    element.textContent = '--';
  });
  $$('.exit-corridor-line').forEach((element) => element.style.removeProperty('--fill'));
  setText('#exit-vwap', '--');
  setText('#exit-slippage', '--');
  setText('#exit-executable', '--');
  renderExitExplanation(null);
  renderDecisionStressTest(null);
  renderAssistantAnswer(null);
  const assistantQuestion = $('#assistant-question');
  if (assistantQuestion) assistantQuestion.value = '';
  const decisionPanel = $('#trader-decision');
  if (decisionPanel) decisionPanel.hidden = true;
  const decisionReview = $('#decision-review');
  if (decisionReview) decisionReview.hidden = true;
  const decisionConfirm = $('#decision-confirm');
  if (decisionConfirm) decisionConfirm.hidden = true;
  $$('.decision-choice').forEach((button) => {
    button.classList.remove('is-selected');
    button.disabled = true;
  });
  setText('#decision-result', '');
  setText('#decision-status', 'Run a successful simulation to choose a trader decision.');
  const decisionQuantity = $('#decision-requested-quantity');
  if (decisionQuantity) decisionQuantity.readOnly = false;
  const note = $('.exit-corridor-note');
  if (note) {
    note.innerHTML =
      'Observed-book estimate, not guaranteed fill. The result is <strong>SIMULATED</strong>; live execution is disabled.';
  }
  $$('.workspace-preset').forEach((button) => button.classList.remove('is-active'));
  const simulateButton = $('#simulate-button');
  if (simulateButton) {
    simulateButton.disabled = false;
    simulateButton.textContent = 'Run exit simulation';
  }
  const provenanceDetails = $('#provenance-details');
  if (provenanceDetails) {
    provenanceDetails.hidden = true;
    provenanceDetails.textContent = '';
  }
  const provenanceToggle = $('#provenance-toggle');
  if (provenanceToggle) provenanceToggle.setAttribute('aria-expanded', 'false');
}

async function initWorkspace() {
  const timeline = $('.workspace-timeline');
  if (timeline) timeline.id = 'workspace-timeline';
  const quantity = $('.workspace-quantity');
  if (quantity && !$('#simulate-button')) {
    const button = document.createElement('button');
    button.id = 'simulate-button';
    button.type = 'button';
    button.className = 'workspace-preset simulate';
    button.textContent = 'Run exit simulation';
    quantity.append(button);
  }
  bindWorkspaceActions();
  try {
    const envelope = await afterMrktApi.getInstruments(12);
    const instruments = envelope.data?.instruments ?? [];
    const preferred = instruments.find((item) => item.providerSymbol === 'RNVDAUSDT');
    const selected = preferred ?? instruments[0];
    renderSelect(instruments, selected?.providerSymbol ?? '');
    if (selected) await loadWorkspace(selected.providerSymbol);
    else throw new Error('No supported instruments are available.');
  } catch (error) {
    setText('#context-status', errorText(error));
    setText('#market-warning', errorText(error));
  }
}

function bindLanding() {
  $$('.landing-faq-panel article').forEach((article) => {
    const button = article.querySelector('button');
    if (!button) return;
    button.addEventListener('click', () => {
      const answer = article.querySelector('p');
      const icon = article.querySelector('b');
      if (!answer || !icon) return;
      const open = article.classList.toggle('is-open');
      answer.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      icon.textContent = open ? '−' : '+';
    });
  });
}

function replayCard(summary) {
  const article = document.createElement('article');
  article.className = 'replay-card';
  article.innerHTML = `<div><span class="replay-mode">REPLAY</span><h3></h3><p></p></div><span class="replay-arrow">↗</span>`;
  article.querySelector('h3').textContent = summary.title;
  article.querySelector('p').textContent =
    `${summary.nativeTicker ?? summary.symbol} · ${formatDate(summary.asOf)} · ${summary.simulationAvailable ? 'simulation available' : 'historical evidence only'}`;
  article.addEventListener('click', () => loadReplayDetail(summary.caseId));
  return article;
}

async function loadReplayDetail(caseId) {
  const detail = $('#replay-detail');
  if (!detail) return;
  detail.hidden = false;
  detail.textContent = 'Loading replay context…';
  try {
    const [replay, context] = await Promise.all([
      afterMrktApi.getReplay(caseId),
      afterMrktApi.getReplayContext(caseId),
    ]);
    const data = context.data;
    detail.replaceChildren();
    const title = document.createElement('h2');
    title.textContent = replay.data.title;
    const meta = document.createElement('p');
    meta.className = 'replay-meta';
    meta.textContent = `REPLAY · ${data.instrument?.nativeTicker ?? replay.data.nativeTicker ?? replay.data.symbol} · as of ${formatDate(data.asOf)}`;
    const explanation = document.createElement('p');
    explanation.textContent = data.explanation?.headline ?? 'Historical context loaded.';
    const limitations = document.createElement('p');
    limitations.className = 'replay-limitations';
    limitations.textContent = [
      ...(replay.data.limitations ?? []),
      ...(data.limitations ?? []),
    ].join(' ');
    detail.append(title, meta, explanation, limitations);
    const event = data.eventContext?.events?.[0];
    if (event) {
      const evidence = document.createElement('div');
      evidence.className = 'replay-event';
      const heading = document.createElement('h3');
      heading.textContent = event.title;
      const source = document.createElement('p');
      source.textContent = `Source fact · available ${formatDate(event.sourceAvailableAt)} · analysis ${event.analysisStatus ?? 'pending'}`;
      const link = document.createElement('a');
      link.href = event.sourceUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'View source evidence';
      evidence.append(heading, source, link);
      detail.append(evidence);
    }
    if (replay.data.simulationAvailable) {
      const form = document.createElement('form');
      form.className = 'replay-simulation';
      form.innerHTML =
        '<label>Position quantity <input inputmode="decimal" required pattern="\\d+(?:\\.\\d+)?" value="0.05" /></label><button class="button button-dark" type="submit">Run replay simulation</button><output></output>';
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = form.querySelector('input');
        const output = form.querySelector('output');
        try {
          const result = await afterMrktApi.simulateReplay(caseId, input.value);
          output.textContent = `${formatMoney(result.data.simulation.estimatedVwap)} VWAP · ${formatNumber(result.data.simulation.unfilledQuantity, '0')} unfilled · observed-book estimate`;
        } catch (error) {
          output.textContent = errorText(error);
        }
      });
      detail.append(form);
    }
  } catch (error) {
    detail.textContent = errorText(error);
  }
}

async function initReplay() {
  const list = $('#replay-list');
  try {
    const envelope = await afterMrktApi.getReplays();
    const replays = envelope.data?.replays ?? [];
    if (!replays.length) {
      list.textContent = 'No curated replay cases are available.';
      return;
    }
    list.replaceChildren(...replays.map(replayCard));
    const caseId = new URLSearchParams(window.location.search).get('caseId');
    if (caseId) await loadReplayDetail(caseId);
  } catch (error) {
    list.textContent = errorText(error);
  }
}

if (page === 'landing') {
  bindLanding();
  void initMarketBelt();
}
if (page === 'workspace') void initWorkspace();
if (page === 'replay') void initReplay();
