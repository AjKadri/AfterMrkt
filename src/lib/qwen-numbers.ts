import Decimal from 'decimal.js';

export type QwenFactUnit =
  'text' | 'status' | 'price' | 'percent' | 'ratio' | 'bps' | 'units' | 'quote';

function fixed(value: Decimal, places: number): string {
  return value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toFixed(places);
}

/** Rounds a deterministic value for display to Qwen. Never uses scientific notation. */
export function formatFactForQwen(value: string, unit: QwenFactUnit): string {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    return value;
  }
  if (!decimal.isFinite()) return value;
  switch (unit) {
    case 'price':
    case 'quote':
      return fixed(decimal, 2);
    case 'bps':
      return `${fixed(decimal, 2)} bps`;
    case 'percent':
      return `${fixed(decimal, 2)}%`;
    case 'ratio':
      return `${decimal.times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed()}%`;
    case 'units':
      return decimal.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed();
    default:
      return value;
  }
}

function normaliseToken(raw: string): string {
  let token = raw.replace(/,/gu, '');
  if (token.includes('.')) token = token.replace(/0+$/u, '').replace(/\.$/u, '');
  return token;
}

/** Extracts normalised numeric tokens: commas stripped, trailing decimal zeros trimmed. */
export function extractNumberTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(/(-?)(\d[\d,]*(?:\.\d+)?)/gu)) {
    const index = match.index ?? 0;
    const sign = match[1] === '-' && !(index > 0 && /[\p{L}\p{N}]/u.test(text[index - 1] ?? ''));
    tokens.push(`${sign ? '-' : ''}${normaliseToken(match[2] ?? '')}`);
  }
  return tokens;
}

export function findUngroundedNumbers(text: string, allowed: Set<string>): string[] {
  const ungrounded = extractNumberTokens(text).filter((token) => !allowed.has(token));
  // Digits outside ASCII (superscripts, other scripts) cannot be matched against the facts.
  const exotic = text.match(/[^\P{N}0-9]/gu) ?? [];
  return [...ungrounded, ...exotic];
}

/** Builds an allowed set from texts; sign-less variants are included for negative tokens. */
export function allowedNumberSet(texts: string[]): Set<string> {
  const allowed = new Set<string>();
  for (const text of texts) {
    for (const token of extractNumberTokens(text)) {
      allowed.add(token);
      if (token.startsWith('-')) allowed.add(token.slice(1));
    }
  }
  return allowed;
}
