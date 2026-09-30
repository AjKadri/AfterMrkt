import { describe, expect, it } from 'vitest';
import {
  extractBoundedFilingEvidence,
  sanitizeFilingHtml,
  SecEdgarAdapter,
} from '../src/adapters/sec/index.js';
import { SecEdgarClient } from '../src/adapters/sec/client.js';
import type { SecFiling } from '../src/adapters/sec/index.js';

describe('SEC EDGAR adapter contracts', () => {
  it('requires a descriptive server-side User-Agent before making a request', async () => {
    const client = new SecEdgarClient({ baseUrl: 'https://example.test' });
    await expect(client.get('/files/company_tickers.json')).rejects.toThrow('SEC_USER_AGENT');
  });

  it('converts filing metadata into an immutable provider-independent source event', () => {
    const adapter = new SecEdgarAdapter({ userAgent: 'AfterMrkt/0.1 (contact: test@example.com)' });
    const filing: SecFiling = {
      ticker: 'MU',
      cik: '0000723125',
      companyName: 'Micron Technology',
      accessionNumber: '0000000000-26-000001',
      form: '8-K',
      filingDate: '2026-08-26',
      reportDate: '2026-08-24',
      acceptanceTimestamp: '2026-08-26T20:06:55.000Z',
      primaryDocument: 'example.htm',
      items: ['2.02'],
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/723125/example.htm',
      retrievedAt: '2026-09-30T07:00:00.000Z',
      rawContentHash: 'a'.repeat(64),
      sourceResponseHash: 'b'.repeat(64),
      content: null,
    };
    const event = adapter.toSourceEvent(filing, 'RMUUSDT');
    expect(event.providerSymbol).toBe('RMUUSDT');
    expect(event.nativeTicker).toBe('MU');
    expect(event.externalId).toBe(filing.accessionNumber);
    expect(event.sourceAvailableAt).toBe(filing.acceptanceTimestamp);
    expect(event.sourceUrl).toContain('sec.gov');
    expect(event.eventId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('retrieves and bounds a primary HTML document around a relevant 8-K item', async () => {
    const originalFetch = globalThis.fetch;
    const html = `
      <html><head><style>.hidden { display:none }</style></head>
      <body><script>ignore this</script>
      <h1>Current Report</h1>
      <div>Item 2.02 Results of Operations and Financial Condition</div>
      <p>The registrant announced quarterly results and furnished the related release.</p>
      <div>Item 9.01 Financial Statements and Exhibits</div>
      <p>Exhibit 99.1.</p></body></html>`;
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(
        'https://www.sec.gov/Archives/edgar/data/723125/000000000026000001/example.htm',
      );
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    try {
      const adapter = new SecEdgarAdapter({
        userAgent: 'AfterMrkt/0.1 (contact: test@example.com)',
        baseUrl: 'https://www.sec.gov',
      });
      const filing: SecFiling = {
        ticker: 'MU',
        cik: '0000723125',
        companyName: 'Micron Technology',
        accessionNumber: '0000000000-26-000001',
        form: '8-K',
        filingDate: '2026-08-26',
        reportDate: null,
        acceptanceTimestamp: '2026-08-26T20:06:55.000Z',
        primaryDocument: 'example.htm',
        items: ['2.02', '9.01'],
        sourceUrl: 'https://www.sec.gov/Archives/edgar/data/723125/000000000026000001/example.htm',
        retrievedAt: '2026-09-30T07:00:00.000Z',
        rawContentHash: 'a'.repeat(64),
        sourceResponseHash: 'b'.repeat(64),
        content: null,
      };
      const content = await adapter.getFilingContent(filing);
      const event = adapter.toSourceEvent(filing, 'RMUUSDT', content);
      expect(sanitizeFilingHtml(html)).not.toContain('ignore this');
      expect(content.extractionStatus).toBe('section-isolated');
      expect(content.relevantItemIds).toEqual(['2.02']);
      expect(content.boundedExcerpt).toContain('quarterly results');
      expect(content.boundedExcerpt).not.toContain('Exhibit 99.1');
      expect(content.excerptEndOffset - content.excerptStartOffset).toBe(
        content.boundedExcerpt.length,
      );
      expect(event.sourceName).toBe('SEC EDGAR primary filing document');
      expect(event.details.contentHash).toBe(content.contentHash);
      expect(event.rawContentHash).toBe(content.contentHash);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('preserves uncertainty when an 8-K item cannot be isolated and enforces excerpt limits', () => {
    const evidence = extractBoundedFilingEvidence(
      'The filing has no recognizable item heading. '.repeat(20),
      '8-K',
      ['2.02'],
      100,
    );
    expect(evidence.extractionStatus).toBe('uncertain');
    expect(evidence.boundedExcerpt.length).toBeLessThanOrEqual(100);
    expect(evidence.relevantItemIds).toEqual(['2.02']);
  });
});
