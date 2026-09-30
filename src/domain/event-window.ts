import type { BitgetCalendar, BitgetMarket } from '../contracts/bitget.js';
import type { SourceEvent } from '../contracts/events.js';

export type EventWindowStatus =
  'qualifies' | 'not_post_close' | 'future_source' | 'time_window_unavailable';

export type EventWindowResult = {
  status: EventWindowStatus;
  sourceAvailableAt: string;
  contextAsOf: string;
  regularSessionClose: string | null;
  reason: string;
};

const DEFAULT_MARKET = 'US';

export type SessionContextResult = {
  status: 'open' | 'closed' | 'unavailable';
  calendarStatus: 'regular-day' | 'weekend' | 'holiday' | 'unknown';
  market: string;
  timeZone: string | null;
  regularSessionOpen: string | null;
  regularSessionClose: string | null;
  previousRegularSessionClose: string | null;
  nextRegularSessionOpen: string | null;
  reason: string;
};

/**
 * The provider currently describes the US session with EST/EDT metadata. We
 * use the IANA zone for calendar arithmetic so daylight-saving transitions do
 * not turn a provider-local close into a guessed UTC offset.
 */
export function evaluatePostCloseWindow(input: {
  event: Pick<SourceEvent, 'sourceAvailableAt'>;
  contextAsOf: string;
  markets: BitgetMarket[] | null;
  calendar: BitgetCalendar | null;
  market?: string;
}): EventWindowResult {
  const sourceMs = Date.parse(input.event.sourceAvailableAt);
  const contextMs = Date.parse(input.contextAsOf);
  const base = {
    sourceAvailableAt: input.event.sourceAvailableAt,
    contextAsOf: input.contextAsOf,
  };
  if (!Number.isFinite(sourceMs) || !Number.isFinite(contextMs)) {
    return {
      ...base,
      status: 'time_window_unavailable',
      regularSessionClose: null,
      reason: 'event or context timestamp is invalid',
    };
  }
  if (sourceMs > contextMs) {
    return {
      ...base,
      status: 'future_source',
      regularSessionClose: null,
      reason: 'source became available after the requested context time',
    };
  }

  const close = resolveRegularSessionClose(
    input.contextAsOf,
    input.markets,
    input.calendar,
    input.market ?? DEFAULT_MARKET,
  );
  if (close === null) {
    return {
      ...base,
      status: 'time_window_unavailable',
      regularSessionClose: null,
      reason: 'regular session close could not be derived from provider calendar data',
    };
  }
  const closeMs = Date.parse(close);
  if (!Number.isFinite(closeMs)) {
    return {
      ...base,
      status: 'time_window_unavailable',
      regularSessionClose: null,
      reason: 'derived regular session close is invalid',
    };
  }
  if (sourceMs > closeMs && sourceMs <= contextMs) {
    return {
      ...base,
      status: 'qualifies',
      regularSessionClose: close,
      reason: 'source became available after the native regular-session close',
    };
  }
  return {
    ...base,
    status: 'not_post_close',
    regularSessionClose: close,
    reason:
      sourceMs <= closeMs
        ? 'source was available at or before the native regular-session close'
        : 'source is outside the requested context window',
  };
}

export function resolveRegularSessionClose(
  contextAsOf: string,
  markets: BitgetMarket[] | null,
  calendar: BitgetCalendar | null,
  market = DEFAULT_MARKET,
): string | null {
  if (markets === null || calendar === null) return null;
  const marketRecord = markets.find((item) => item.market.toUpperCase() === market.toUpperCase());
  const regular = marketRecord?.stateList?.find((state) => state.state.toLowerCase() === 'regular');
  const endTime = regular?.endTime;
  if (endTime === undefined) return null;
  const time = parseLocalTime(endTime);
  if (time === null) return null;
  const timeZone = resolveTimeZone(calendar.timeZone, regular?.timeZone);
  if (timeZone === null) return null;

  const localDate = localDateParts(contextAsOf, timeZone);
  if (localDate === null || !isTradingWeekday(localDate.weekday, calendar.regularConfig)) {
    return null;
  }
  if (isClosedBySpecificCalendar(localDate.isoDate, calendar)) return null;

  return zonedLocalTimestamp(localDate.isoDate, time.hours, time.minutes, time.seconds, timeZone);
}

export function resolveNextRegularSessionOpen(
  afterAsOf: string,
  markets: BitgetMarket[] | null,
  calendar: BitgetCalendar | null,
  market = DEFAULT_MARKET,
): string | null {
  if (markets === null || calendar === null) return null;
  const marketRecord = markets.find((item) => item.market.toUpperCase() === market.toUpperCase());
  const regular = marketRecord?.stateList?.find((state) => state.state.toLowerCase() === 'regular');
  const startTime = regular?.startTime;
  if (startTime === undefined) return null;
  const time = parseLocalTime(startTime);
  if (time === null) return null;
  const timeZone = resolveTimeZone(calendar.timeZone, regular?.timeZone);
  if (timeZone === null) return null;
  const baseDate = localDateParts(afterAsOf, timeZone);
  if (baseDate === null) return null;
  for (let offset = 0; offset <= 14; offset += 1) {
    const isoDate = addIsoDays(baseDate.isoDate, offset);
    const candidateDate = localDateParts(`${isoDate}T12:00:00.000Z`, timeZone);
    if (
      candidateDate === null ||
      !isTradingWeekday(candidateDate.weekday, calendar.regularConfig)
    ) {
      continue;
    }
    if (isClosedBySpecificCalendar(isoDate, calendar)) continue;
    const open = zonedLocalTimestamp(isoDate, time.hours, time.minutes, time.seconds, timeZone);
    if (open !== null && Date.parse(open) > Date.parse(afterAsOf)) return open;
  }
  return null;
}

/**
 * Derive session state only from a complete provider schedule. The context
 * engine deliberately does not fill missing calendar fields with production
 * assumptions.
 */
export function deriveSessionContext(input: {
  asOf: string;
  markets: BitgetMarket[] | null;
  calendar: BitgetCalendar | null;
  market?: string;
}): SessionContextResult {
  const market = input.market ?? DEFAULT_MARKET;
  const schedule = resolveRegularSessionSchedule(input.markets, input.calendar, market);
  const unavailable = (reason: string): SessionContextResult => ({
    status: 'unavailable',
    calendarStatus: 'unknown',
    market,
    timeZone: schedule?.timeZone ?? null,
    regularSessionOpen: null,
    regularSessionClose: null,
    previousRegularSessionClose: null,
    nextRegularSessionOpen: null,
    reason,
  });
  const asOfMs = Date.parse(input.asOf);
  if (!Number.isFinite(asOfMs)) return unavailable('context timestamp is invalid');
  if (schedule === null) {
    return unavailable('provider market state or calendar schedule is incomplete');
  }
  const localDate = localDateParts(input.asOf, schedule.timeZone);
  if (localDate === null) return unavailable('context local date could not be derived');
  const calendarStatus = isTradingWeekday(localDate.weekday, input.calendar?.regularConfig)
    ? isClosedBySpecificCalendar(localDate.isoDate, input.calendar)
      ? 'holiday'
      : 'regular-day'
    : 'weekend';
  const currentOpen =
    calendarStatus === 'regular-day'
      ? zonedLocalTimestamp(
          localDate.isoDate,
          schedule.start.hours,
          schedule.start.minutes,
          schedule.start.seconds,
          schedule.timeZone,
        )
      : null;
  const currentClose =
    calendarStatus === 'regular-day'
      ? zonedLocalTimestamp(
          localDate.isoDate,
          schedule.end.hours,
          schedule.end.minutes,
          schedule.end.seconds,
          schedule.timeZone,
        )
      : null;
  const previousClose = resolvePreviousRegularSessionClose(
    input.asOf,
    input.markets,
    input.calendar,
    market,
  );
  const nextOpen = resolveNextRegularSessionOpen(input.asOf, input.markets, input.calendar, market);
  const openMs = currentOpen === null ? null : Date.parse(currentOpen);
  const closeMs = currentClose === null ? null : Date.parse(currentClose);
  const status =
    calendarStatus === 'regular-day' &&
    openMs !== null &&
    closeMs !== null &&
    Number.isFinite(openMs) &&
    Number.isFinite(closeMs) &&
    asOfMs >= openMs &&
    asOfMs < closeMs
      ? 'open'
      : 'closed';
  return {
    status,
    calendarStatus,
    market,
    timeZone: schedule.timeZone,
    regularSessionOpen: currentOpen,
    regularSessionClose: currentClose,
    previousRegularSessionClose: previousClose,
    nextRegularSessionOpen: nextOpen,
    reason:
      status === 'open'
        ? 'context time is within the provider-defined regular session'
        : `context time is outside the provider-defined regular session (${calendarStatus})`,
  };
}

export function resolvePreviousRegularSessionClose(
  asOf: string,
  markets: BitgetMarket[] | null,
  calendar: BitgetCalendar | null,
  market = DEFAULT_MARKET,
): string | null {
  const schedule = resolveRegularSessionSchedule(markets, calendar, market);
  if (schedule === null || !Number.isFinite(Date.parse(asOf))) return null;
  const baseDate = localDateParts(asOf, schedule.timeZone);
  if (baseDate === null) return null;
  for (let offset = 0; offset <= 14; offset += 1) {
    const isoDate = addIsoDays(baseDate.isoDate, -offset);
    const candidateDate = localDateParts(`${isoDate}T12:00:00.000Z`, schedule.timeZone);
    if (
      candidateDate === null ||
      !isTradingWeekday(candidateDate.weekday, calendar?.regularConfig) ||
      isClosedBySpecificCalendar(isoDate, calendar)
    ) {
      continue;
    }
    const close = zonedLocalTimestamp(
      isoDate,
      schedule.end.hours,
      schedule.end.minutes,
      schedule.end.seconds,
      schedule.timeZone,
    );
    if (close !== null && Date.parse(close) <= Date.parse(asOf)) return close;
  }
  return null;
}

export function resolveRegularSessionSchedule(
  markets: BitgetMarket[] | null,
  calendar: BitgetCalendar | null,
  market = DEFAULT_MARKET,
): {
  timeZone: string;
  start: { hours: number; minutes: number; seconds: number };
  end: { hours: number; minutes: number; seconds: number };
} | null {
  if (markets === null || calendar === null || calendar.regularConfig === undefined) return null;
  const marketRecord = markets.find((item) => item.market.toUpperCase() === market.toUpperCase());
  const regular = marketRecord?.stateList?.find((state) => state.state.toLowerCase() === 'regular');
  if (regular?.startTime === undefined || regular.endTime === undefined) return null;
  const start = parseLocalTime(regular.startTime);
  const end = parseLocalTime(regular.endTime);
  const timeZone = resolveTimeZone(calendar.timeZone, regular.timeZone);
  if (start === null || end === null || timeZone === null) return null;
  return { timeZone, start, end };
}

function resolveTimeZone(calendarTimeZone: string | undefined, marketTimeZone: string | undefined) {
  const value = (calendarTimeZone ?? marketTimeZone ?? '').trim();
  if (value === '') return null;
  if (value.includes('/')) return value;
  if (value.toUpperCase() === 'EST' || value.toUpperCase() === 'EDT') {
    return 'America/New_York';
  }
  return null;
}

function parseLocalTime(value: string): { hours: number; minutes: number; seconds: number } | null {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? '0');
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return { hours, minutes, seconds };
}

function localDateParts(
  timestamp: string,
  timeZone: string,
): { isoDate: string; weekday: string } | null {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(parsed).map((part) => [part.type, part.value]),
  );
  if (
    typeof parts.year !== 'string' ||
    typeof parts.month !== 'string' ||
    typeof parts.day !== 'string' ||
    typeof parts.weekday !== 'string'
  ) {
    return null;
  }
  return { isoDate: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday };
}

function isTradingWeekday(weekday: string, regularConfig: string[] | undefined): boolean {
  if (regularConfig === undefined || regularConfig.length === 0) {
    return !['Saturday', 'Sunday'].includes(weekday);
  }
  const normalized = regularConfig.map((item) => item.toLowerCase());
  const isConfiguredClosed = normalized.some(
    (item) => item === weekday.toLowerCase() || item.startsWith(weekday.slice(0, 3).toLowerCase()),
  );
  // Bitget's live US calendar uses regularConfig for recurring non-trading
  // weekdays, currently SATURDAY and SUNDAY.
  return !isConfiguredClosed;
}

function isClosedBySpecificCalendar(date: string, calendar: BitgetCalendar | null): boolean {
  if (calendar === null) return false;
  return (calendar.specificConfig ?? []).some((entry) => {
    const start = entry.startTime?.slice(0, 10);
    const end = entry.endTime?.slice(0, 10) ?? start;
    if (start === undefined || end === undefined) return false;
    return start <= date && date <= end;
  });
}

function zonedLocalTimestamp(
  isoDate: string,
  hours: number,
  minutes: number,
  seconds: number,
  timeZone: string,
): string | null {
  const [year, month, day] = isoDate.split('-').map(Number);
  const approximateUtc = new Date(
    Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1, hours, minutes, seconds),
  );
  if (!Number.isFinite(approximateUtc.getTime())) return null;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const offsetPart = formatter
    .formatToParts(approximateUtc)
    .find((part) => part.type === 'timeZoneName')?.value;
  const offset = parseOffset(offsetPart);
  if (offset === null) return null;
  return new Date(approximateUtc.getTime() - offset * 60_000).toISOString();
}

function addIsoDays(isoDate: string, days: number): string {
  const parsed = new Date(`${isoDate}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return isoDate;
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function parseOffset(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^GMT([+-])(\d{2}):?(\d{2})?$/.exec(value);
  if (match === null) return value === 'GMT' ? 0 : null;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? '0');
  return match[1] === '+' ? minutes : -minutes;
}
