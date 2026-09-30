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
  sourceUrl: string;
  retrievedAt: string;
  rawContentHash: string;
  sourceResponseHash: string;
};

export type SecEdgarProvider = {
  getTickerCik(ticker: string): Promise<{ ticker: string; cik: string; companyName: string }>;
  getRecentFilings(ticker: string, limit?: number): Promise<SecFiling[]>;
  toSourceEvent(filing: SecFiling, providerSymbol: string): SourceEvent;
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

  toSourceEvent(filing: SecFiling, providerSymbol: string): SourceEvent {
    const sourceAvailableAt = filing.acceptanceTimestamp ?? filing.retrievedAt;
    const excerpt = [
      `SEC ${filing.form} filing for ${filing.ticker}.`,
      `Filing date: ${filing.filingDate}.`,
      `Accession number: ${filing.accessionNumber}.`,
      filing.reportDate === null ? null : `Report date: ${filing.reportDate}.`,
    ]
      .filter((item): item is string => item !== null)
      .join(' ');
    const details = {
      cik: filing.cik,
      form: filing.form,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      acceptanceTimestamp: filing.acceptanceTimestamp,
      primaryDocument: filing.primaryDocument,
    };
    const rawContentHash = sha256(canonicalJson(details));
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
      sourceName: 'SEC EDGAR submissions',
      sourceUrl: filing.sourceUrl,
      externalId: filing.accessionNumber,
      title: `${filing.form} filing for ${filing.ticker}`,
      excerpt,
      publishedAt: null,
      eventOccurredAt: null,
      sourceAvailableAt,
      retrievedAt: filing.retrievedAt,
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
    });
  }
  return filings;
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
export type { SecClientOptions, SecRequestResult } from './client.js';
