import { describe, expect, it } from 'vitest';
import { SecEdgarAdapter } from '../src/adapters/sec/index.js';
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
      sourceUrl: 'https://www.sec.gov/Archives/edgar/data/723125/example.htm',
      retrievedAt: '2026-09-30T07:00:00.000Z',
      rawContentHash: 'a'.repeat(64),
      sourceResponseHash: 'b'.repeat(64),
    };
    const event = adapter.toSourceEvent(filing, 'RMUUSDT');
    expect(event.providerSymbol).toBe('RMUUSDT');
    expect(event.nativeTicker).toBe('MU');
    expect(event.externalId).toBe(filing.accessionNumber);
    expect(event.sourceAvailableAt).toBe(filing.acceptanceTimestamp);
    expect(event.sourceUrl).toContain('sec.gov');
    expect(event.eventId).toMatch(/^[a-f0-9]{64}$/);
  });
});
