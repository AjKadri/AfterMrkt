import { z } from 'zod';

const StringOrNull = z.string().nullable();

export const SecTickerRecordSchema = z.object({
  cik_str: z.union([z.string(), z.number()]),
  ticker: z.string(),
  title: z.string(),
});

export const SecTickerMapSchema = z.record(z.string(), SecTickerRecordSchema);

export const SecRecentSubmissionsSchema = z
  .object({
    accessionNumber: z.array(z.string()),
    filingDate: z.array(z.string()),
    reportDate: z.array(StringOrNull),
    acceptanceDateTime: z.array(z.string()),
    form: z.array(z.string()),
    primaryDocument: z.array(z.string()),
    items: z.array(z.string()).optional(),
  })
  .passthrough();

export const SecSubmissionsSchema = z
  .object({
    name: z.string(),
    cik: z.string(),
    tickers: z.array(z.string()).optional(),
    filings: z.object({ recent: SecRecentSubmissionsSchema }),
  })
  .passthrough();

export type SecTickerRecord = z.infer<typeof SecTickerRecordSchema>;
export type SecTickerMap = z.infer<typeof SecTickerMapSchema>;
export type SecRecentSubmissions = z.infer<typeof SecRecentSubmissionsSchema>;
export type SecSubmissions = z.infer<typeof SecSubmissionsSchema>;
