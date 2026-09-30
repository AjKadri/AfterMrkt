import { z } from 'zod';
import { sha256 } from '../../lib/hash.js';
import { canonicalJson } from '../../lib/canonical.js';
import { hashRawResponse } from '../../observability/evidence.js';
import { ProbeError } from '../../lib/errors.js';
import {
  SecRecentSubmissionsSchema,
  SecSubmissionsSchema,
  SecTickerMapSchema,
  type SecRecentSubmissions,
} from '../../contracts/sec.js';
import type { SourceEvent } from '../../contracts/events.js';
import { SecEdgarClient, type SecClientOptions, type SecRequestResult } from './client.js';

export const DEFAULT_SEC_EXCERPT_MAX_CHARS = 3_600;
const TARGET_8K_ITEMS = ['1.01', '2.02', '5.02', '7.01', '8.01'];

export type SecEvidenceExtractionStatus = 'section-isolated' | 'document-bounded' | 'uncertain';

export type SecFilingContent = {
  contentHash: string;
  contentResponseHash: string;
  retrievedAt: string;
  boundedExcerpt: string;
  excerptStartOffset: number;
  excerptEndOffset: number;
  relevantItemIds: string[];
  extractionStatus: SecEvidenceExtractionStatus;
  sanitizedTextLength: number;
};

export type SecFiling = {
  ticker: string;
  cik: string;
  companyName: string;
  accessionNumber: string;
  form: '8-K' | '10-Q' | '10-K';
  filingDate: string;
  reportDate: string | null;
  acceptanceTimestamp: string | null;
  primaryDocument: string;
  items: string[];
  sourceUrl: string;
  retrievedAt: string;
  rawContentHash: string;
  sourceResponseHash: string;
  content: SecFilingContent | null;
};

export type SecEdgarProvider = {
  getTickerCik(ticker: string): Promise<{ ticker: string; cik: string; companyName: string }>;
  getRecentFilings(ticker: string, limit?: number): Promise<SecFiling[]>;
  getFilingContent(filing: SecFiling): Promise<SecFilingContent>;
  toSourceEvent(filing: SecFiling, providerSymbol: string, content?: SecFilingContent): SourceEvent;
};

export class SecEdgarAdapter implements SecEdgarProvider {
  readonly client: SecEdgarClient;
  private tickerMap: Map<string, { cik: string; companyName: string }> | null = null;

  constructor(options: SecClientOptions = {}) {
    this.client = new SecEdgarClient(options);
  }

  async getTickerCik(
    ticker: string,
  ): Promise<{ ticker: string; cik: string; companyName: string }> {
    const normalizedTicker = normalizeTicker(ticker);
    const map = await this.getTickerMap();
    const result = map.get(normalizedTicker);
    if (!result) {
      throw new ProbeError('instrument_missing', `SEC ticker ${normalizedTicker} was not found`);
    }
    return { ticker: normalizedTicker, ...result };
  }

  async getRecentFilings(ticker: string, limit = 20): Promise<SecFiling[]> {
    const identity = await this.getTickerCik(ticker);
    const result = await this.client.getData(`/submissions/CIK${identity.cik}.json`);
    const submissions = SecSubmissionsSchema.safeParse(result.json);
    if (!submissions.success) {
      throw new ProbeError('malformed_provider_data', formatZodError(submissions.error));
    }
    const recent = SecRecentSubmissionsSchema.parse(submissions.data.filings.recent);
    return selectFilings(recent, identity, result, limit);
  }

  async getFilingContent(filing: SecFiling): Promise<SecFilingContent> {
    const sourceUrl = new URL(filing.sourceUrl);
    const result = await this.client.getText(sourceUrl.pathname);
    const sanitizedText = sanitizeFilingHtml(result.text);
    if (sanitizedText.length === 0) {
      throw new ProbeError('malformed_provider_data', 'SEC primary filing had no meaningful text');
    }
    const evidence = extractBoundedFilingEvidence(
      sanitizedText,
      filing.form,
      filing.items,
      DEFAULT_SEC_EXCERPT_MAX_CHARS,
    );
    const contentHash = hashRawResponse(result.text);
    return {
      contentHash,
      contentResponseHash: contentHash,
      retrievedAt: result.raw.receivedAt,
      boundedExcerpt: evidence.boundedExcerpt,
      excerptStartOffset: evidence.excerptStartOffset,
      excerptEndOffset: evidence.excerptEndOffset,
      relevantItemIds: evidence.relevantItemIds,
      extractionStatus: evidence.extractionStatus,
      sanitizedTextLength: sanitizedText.length,
    };
  }

  toSourceEvent(filing: SecFiling, providerSymbol: string, content = filing.content): SourceEvent {
    const sourceAvailableAt =
      filing.acceptanceTimestamp ?? content?.retrievedAt ?? filing.retrievedAt;
    const retrievedAt = content?.retrievedAt ?? filing.retrievedAt;
    const excerpt = content?.boundedExcerpt ?? metadataExcerpt(filing);
    const contentHash = content?.contentHash ?? null;
    const rawContentHash = contentHash ?? filing.rawContentHash;
    const details = {
      cik: filing.cik,
      companyName: filing.companyName,
      form: filing.form,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      acceptanceTimestamp: filing.acceptanceTimestamp,
      primaryDocument: filing.primaryDocument,
      items: filing.items,
      contentHash,
      contentRetrievedAt: content?.retrievedAt ?? null,
      contentResponseHash: content?.contentResponseHash ?? null,
      excerptStartOffset: content?.excerptStartOffset ?? 0,
      excerptEndOffset: content?.excerptEndOffset ?? excerpt.length,
      relevantItemIds: content?.relevantItemIds ?? [],
      extractionStatus: content?.extractionStatus ?? 'uncertain',
      sanitizedTextLength: content?.sanitizedTextLength ?? excerpt.length,
    };
    const eventId = sha256(
      canonicalJson({
        sourceType: 'sec-edgar',
        externalId: filing.accessionNumber,
        providerSymbol,
        nativeTicker: filing.ticker,
        rawContentHash,
      }),
    );
    return {
      eventId,
      providerSymbol,
      nativeTicker: filing.ticker,
      sourceType: 'sec-edgar',
      sourceName: content === null ? 'SEC EDGAR submissions' : 'SEC EDGAR primary filing document',
      sourceUrl: filing.sourceUrl,
      externalId: filing.accessionNumber,
      title: `${filing.form} filing for ${filing.ticker}`,
      excerpt,
      publishedAt: null,
      eventOccurredAt: null,
      sourceAvailableAt,
      retrievedAt,
      category: 'sec_filing',
      rawContentHash,
      details,
    };
  }

  private async getTickerMap(): Promise<Map<string, { cik: string; companyName: string }>> {
    if (this.tickerMap !== null) return this.tickerMap;
    const result = await this.client.get('/files/company_tickers.json');
    const parsed = SecTickerMapSchema.safeParse(result.json);
    if (!parsed.success) {
      throw new ProbeError('malformed_provider_data', formatZodError(parsed.error));
    }
    this.tickerMap = new Map(
      Object.values(parsed.data).map((entry) => [
        normalizeTicker(entry.ticker),
        { cik: normalizeCik(entry.cik_str), companyName: entry.title },
      ]),
    );
    return this.tickerMap;
  }
}

type BoundedFilingEvidence = {
  boundedExcerpt: string;
  excerptStartOffset: number;
  excerptEndOffset: number;
  relevantItemIds: string[];
  extractionStatus: SecEvidenceExtractionStatus;
};

export function sanitizeFilingHtml(input: string): string {
  return input
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/?(br|p|div|li|tr|h[1-6]|table|section|article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, value: string) => decodeNumericEntity(value))
    .replace(/&#x([\da-f]+);/gi, (_match, value: string) => decodeNumericEntity(value, 16))
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

export function extractBoundedFilingEvidence(
  sanitizedText: string,
  form: SecFiling['form'],
  metadataItems: string[],
  maxChars = DEFAULT_SEC_EXCERPT_MAX_CHARS,
): BoundedFilingEvidence {
  const normalizedMetadataItems = metadataItems.map(normalizeItemId).filter(isItemId);
  const targetItems = new Set(
    form === '8-K' && normalizedMetadataItems.length > 0
      ? normalizedMetadataItems
      : form === '8-K'
        ? TARGET_8K_ITEMS
        : [],
  );
  const headings = [...sanitizedText.matchAll(/\bItem\s+(\d+\.\d+)\b/gi)].map((match) => ({
    itemId: normalizeItemId(match[1] ?? ''),
    start: match.index ?? 0,
  }));
  const relevantHeading = headings.find((heading) => targetItems.has(heading.itemId));
  if (relevantHeading !== undefined) {
    const nextHeading = headings.find((heading) => heading.start > relevantHeading.start);
    const sectionEnd = Math.min(
      nextHeading?.start ?? sanitizedText.length,
      relevantHeading.start + maxChars,
    );
    const bounds = trimBounds(sanitizedText, relevantHeading.start, sectionEnd);
    return {
      boundedExcerpt: sanitizedText.slice(bounds.start, bounds.end),
      excerptStartOffset: bounds.start,
      excerptEndOffset: bounds.end,
      relevantItemIds: [relevantHeading.itemId],
      extractionStatus: 'section-isolated',
    };
  }

  const bounds = trimBounds(sanitizedText, 0, Math.min(sanitizedText.length, maxChars));
  return {
    boundedExcerpt: sanitizedText.slice(bounds.start, bounds.end),
    excerptStartOffset: bounds.start,
    excerptEndOffset: bounds.end,
    relevantItemIds: normalizedMetadataItems,
    extractionStatus: form === '8-K' ? 'uncertain' : 'document-bounded',
  };
}

function selectFilings(
  recent: SecRecentSubmissions,
  identity: { ticker: string; cik: string; companyName: string },
  result: SecRequestResult,
  limit: number,
): SecFiling[] {
  const filings: SecFiling[] = [];
  for (let index = 0; index < recent.form.length && filings.length < limit; index += 1) {
    const form = recent.form[index];
    if (form !== '8-K' && form !== '10-Q' && form !== '10-K') continue;
    const accessionNumber = recent.accessionNumber[index];
    const filingDate = recent.filingDate[index];
    const primaryDocument = recent.primaryDocument[index];
    const acceptance = recent.acceptanceDateTime[index];
    if (
      accessionNumber === undefined ||
      filingDate === undefined ||
      primaryDocument === undefined
    ) {
      throw new ProbeError('malformed_provider_data', `SEC filing row ${index} is incomplete`);
    }
    const accessionPath = accessionNumber.replaceAll('-', '');
    const numericCik = identity.cik.replace(/^0+/, '') || '0';
    const sourceUrl = `https://www.sec.gov/Archives/edgar/data/${numericCik}/${accessionPath}/${primaryDocument}`;
    filings.push({
      ticker: identity.ticker,
      cik: identity.cik,
      companyName: identity.companyName,
      accessionNumber,
      form,
      filingDate,
      reportDate: recent.reportDate[index] ?? null,
      acceptanceTimestamp: normalizeSecTimestamp(acceptance),
      primaryDocument,
      items: parseItemIds(recent.items?.[index]),
      sourceUrl,
      retrievedAt: result.raw.receivedAt,
      rawContentHash: sha256(
        canonicalJson({
          accessionNumber,
          filingDate,
          form,
          primaryDocument,
          reportDate: recent.reportDate[index] ?? null,
          acceptanceTimestamp: acceptance ?? null,
        }),
      ),
      sourceResponseHash: hashRawResponse(result.raw.bodyText),
      content: null,
    });
  }
  return filings;
}

function metadataExcerpt(filing: SecFiling): string {
  return [
    `SEC ${filing.form} filing for ${filing.ticker}.`,
    `Filing date: ${filing.filingDate}.`,
    `Accession number: ${filing.accessionNumber}.`,
    filing.reportDate === null ? null : `Report date: ${filing.reportDate}.`,
  ]
    .filter((item): item is string => item !== null)
    .join(' ');
}

function parseItemIds(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...value.matchAll(/\d+\.\d+/g)].map((match) => normalizeItemId(match[0] ?? ''));
}

function normalizeItemId(value: string): string {
  return value
    .trim()
    .replace(/^Item\s+/i, '')
    .replace(/\.$/, '');
}

function isItemId(value: string): value is `${number}.${number}` {
  return /^\d+\.\d+$/.test(value);
}

function trimBounds(text: string, start: number, end: number): { start: number; end: number } {
  let boundedStart = start;
  let boundedEnd = end;
  while (boundedStart < boundedEnd && /\s/.test(text[boundedStart] ?? '')) boundedStart += 1;
  while (boundedEnd > boundedStart && /\s/.test(text[boundedEnd - 1] ?? '')) boundedEnd -= 1;
  return { start: boundedStart, end: boundedEnd };
}

function decodeNumericEntity(value: string, radix = 10): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : ' ';
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function normalizeCik(value: string | number): string {
  return String(value)
    .replace(/^0+(?=\d)/, '')
    .padStart(10, '0');
}

function normalizeSecTimestamp(value: string | undefined): string | null {
  if (value === undefined || value.trim() === '') return null;
  const parsed = new Date(value.replace(/(\d{2})(\d{2})$/, '$1:$2'));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

export { SecEdgarClient } from './client.js';
export type { SecClientOptions, SecRequestResult, SecTextRequestResult } from './client.js';
