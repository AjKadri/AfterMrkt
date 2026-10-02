/* global document, URLSearchParams, window */

import { afterMrktApi, AfterMrktApiError } from './lib/aftermrkt-api.js';

const page = document.body.dataset.page;
const state = { symbol: null, context: null, eventData: null, requestId: 0 };

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

  const eventStatus = context.eventContext?.status ?? 'unavailable';
  setText(
    '#evidence-summary',
    context.eventContext?.qualifyingEventCount
      ? `${context.eventContext.qualifyingEventCount} qualifying source event found. Analysis remains separately attributed.`
      : eventStatus,
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
    setText('#analysis-status', 'Qwen analysis · unavailable');
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
  setText(
    '#analysis-status',
    `Qwen analysis · ${analysis?.status ?? sourceEvent.analysisStatus ?? 'pending'}`,
  );
  const detail = $('#evidence-detail');
  if (detail && event) {
    detail.replaceChildren(
      document.createTextNode(
        `${event.source?.label ?? 'Source'} · ${event.source?.url ?? 'URL unavailable'}`,
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
  $('#simulate-button')?.addEventListener('click', () =>
    runSimulationSuite($('#position-quantity')?.value ?? ''),
  );
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
  const numerator = fraction === '0.75' ? (digits * 3n) / denominator : digits / denominator;
  const scale = decimal.length;
  const raw = numerator.toString().padStart(scale + 1, '0');
  const split = raw.length - scale;
  const output = scale ? `${raw.slice(0, split)}.${raw.slice(split)}` : raw;
  return output.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function renderSimulation(simulations) {
  const [quarter, threeQuarter, full] = simulations;
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
  const note = $('.exit-corridor-note');
  if (note && full)
    note.innerHTML = `Observed-book estimate, not guaranteed fill. ${formatNumber(full.unfilledQuantity, '0')} ${full.symbol} remains unfilled against the captured depth. The result is <strong>SIMULATED</strong>; live execution is disabled.`;
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
      quantities.map((item) => afterMrktApi.simulate(symbol, item)),
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
    article.addEventListener('click', () => {
      const answer = article.querySelector('p');
      const icon = article.querySelector('b');
      if (!answer || !icon) return;
      const open = article.classList.toggle('is-open');
      answer.hidden = !open;
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

if (page === 'landing') bindLanding();
if (page === 'workspace') void initWorkspace();
if (page === 'replay') void initReplay();
