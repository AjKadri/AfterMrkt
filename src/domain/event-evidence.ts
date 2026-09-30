import { sha256 } from '../lib/hash.js';
import type { EvidenceSpan } from '../contracts/evidence.js';

export const DEFAULT_EVIDENCE_SPAN_MAX_CHARS = 1_000;

type TextRange = {
  startOffset: number;
  endOffset: number;
};

/**
 * Segment a bounded source excerpt without asking the model to invent evidence
 * coordinates. Paragraph-like lines are preferred, then sentence or whitespace
 * boundaries are used only when a single line exceeds the configured limit.
 */
export function buildDeterministicEvidenceSpans(
  excerpt: string,
  maxChars = DEFAULT_EVIDENCE_SPAN_MAX_CHARS,
): EvidenceSpan[] {
  if (excerpt.length === 0) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new Error('evidence span maximum must be a positive integer');
  }

  const ranges = [...excerpt.matchAll(/[^\n]+/g)].flatMap((match) => {
    const startOffset = match.index ?? 0;
    return splitRange(excerpt, { startOffset, endOffset: startOffset + match[0].length }, maxChars);
  });

  return ranges.map((range, index) => {
    const text = excerpt.slice(range.startOffset, range.endOffset);
    return {
      id: `span-${index + 1}`,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
      text,
      contentHash: sha256(text),
    };
  });
}

function splitRange(excerpt: string, range: TextRange, maxChars: number): TextRange[] {
  const ranges: TextRange[] = [];
  let cursor = range.startOffset;
  while (cursor < range.endOffset) {
    const remaining = range.endOffset - cursor;
    if (remaining <= maxChars) {
      ranges.push({ startOffset: cursor, endOffset: range.endOffset });
      break;
    }

    const limit = cursor + maxChars;
    const window = excerpt.slice(cursor, limit);
    const sentenceBoundary = findLastBoundary(window, /[.!?]+(?:\s+|$)/g);
    const whitespaceBoundary = findLastBoundary(window, /\s+/g);
    const splitLength = sentenceBoundary ?? whitespaceBoundary ?? maxChars;
    const endOffset = cursor + Math.max(splitLength, 1);
    ranges.push({ startOffset: cursor, endOffset });
    cursor = endOffset;
  }
  return ranges;
}

function findLastBoundary(text: string, pattern: RegExp): number | null {
  let last: number | null = null;
  for (const match of text.matchAll(pattern)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end > 0 && end <= text.length) last = end;
  }
  return last;
}
