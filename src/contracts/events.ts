import { z } from 'zod';
import { EvidenceSpanSchema } from './evidence.js';

const DateTimeSchema = z.string().datetime({ offset: true });
const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const EventSourceDetailsSchema = z.record(z.string(), z.unknown());

export const SourceEventSchema = z.object({
  eventId: HashSchema,
  providerSymbol: z.string().min(1),
  nativeTicker: z.string().min(1),
  sourceType: z.string().min(1),
  sourceName: z.string().min(1),
  sourceUrl: z.string().url(),
  externalId: z.string().min(1).nullable(),
  title: z.string().min(1),
  excerpt: z.string().min(1).max(4_000),
  publishedAt: DateTimeSchema.nullable(),
  eventOccurredAt: DateTimeSchema.nullable(),
  sourceAvailableAt: DateTimeSchema,
  retrievedAt: DateTimeSchema,
  category: z.string().min(1),
  rawContentHash: HashSchema,
  details: EventSourceDetailsSchema,
});

export const EventAnalysisEvidenceSpanSchema = EvidenceSpanSchema;

export const EventAnalysisEntitySchema = z.object({
  name: z.string().min(1),
  ticker: z.string().min(1).nullable(),
});

export const EventAnalysisFactSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  evidenceSpanIds: z.array(z.string().min(1)).min(1),
  supportingQuote: z.string().min(1).optional(),
});

export const EventAnalysisMaterialitySchema = z.enum([
  'material',
  'possibly_material',
  'not_material',
  'insufficient_evidence',
]);

export const EventAnalysisStatusSchema = z.enum(['validated', 'quarantined', 'unavailable']);

export const EventAnalysisSchema = z.object({
  analysisId: HashSchema,
  eventId: HashSchema,
  model: z.string().min(1),
  providerReportedModel: z.string().nullable(),
  thinkingMode: z.enum(['provider-default', 'disabled', 'enabled']),
  promptVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  eventType: z.string().min(1),
  entities: z.array(EventAnalysisEntitySchema),
  status: EventAnalysisStatusSchema,
  materiality: EventAnalysisMaterialitySchema,
  facts: z.array(EventAnalysisFactSchema),
  uncertainties: z.array(z.string()),
  evidenceSpans: z.array(EventAnalysisEvidenceSpanSchema),
  confidence: z.number().min(0).max(1).nullable(),
  sourceBound: z.boolean(),
  inputTokens: z.number().int().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  totalTokens: z.number().int().nonnegative().nullable(),
  cacheTokens: z.number().int().nonnegative().nullable(),
  providerReportedCostUsd: z.string().nullable(),
  estimatedCost: z.string().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  processedAt: DateTimeSchema,
  attemptCount: z.number().int().positive(),
  retryReason: z.string().nullable(),
  errorCode: z.string().nullable(),
  validationIssues: z.array(z.string()),
});

export type SourceEvent = z.infer<typeof SourceEventSchema>;
export type EventSourceDetails = z.infer<typeof EventSourceDetailsSchema>;
export type EventAnalysisEvidenceSpan = z.infer<typeof EventAnalysisEvidenceSpanSchema>;
export type EventAnalysisEntity = z.infer<typeof EventAnalysisEntitySchema>;
export type EventAnalysisFact = z.infer<typeof EventAnalysisFactSchema>;
export type EventAnalysisMateriality = z.infer<typeof EventAnalysisMaterialitySchema>;
export type EventAnalysisStatus = z.infer<typeof EventAnalysisStatusSchema>;
export type EventAnalysis = z.infer<typeof EventAnalysisSchema>;
