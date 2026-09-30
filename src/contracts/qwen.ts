import { z } from 'zod';

export const QwenEntitySchema = z.object({
  name: z.string(),
  ticker: z.string().nullable(),
});

export const QwenEvidenceSpanSchema = z.object({
  id: z.string().min(1),
  quote: z.string(),
  start: z.number().int().nonnegative().nullable().optional(),
  end: z.number().int().nonnegative().nullable().optional(),
});

export const QwenFactSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  evidenceSpanIds: z.array(z.string().min(1)).min(1),
});

export const QwenEventSchema = z.object({
  eventType: z.string(),
  entities: z.array(QwenEntitySchema),
  materiality: z.enum(['material', 'possibly_material', 'not_material', 'insufficient_evidence']),
  facts: z.array(QwenFactSchema),
  uncertainties: z.array(z.string()),
  evidenceSpans: z.array(QwenEvidenceSpanSchema),
  confidence: z.number().min(0).max(1),
  sourceBound: z.boolean(),
  model: z.string(),
  promptVersion: z.string(),
});

export type QwenEvent = z.infer<typeof QwenEventSchema>;

export const QwenUsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    reasoning_tokens: z.number().optional(),
    cached_tokens: z.number().optional(),
    prompt_tokens_details: z
      .object({ cached_tokens: z.number().optional() })
      .passthrough()
      .optional(),
    completion_tokens_details: z.record(z.string(), z.unknown()).optional(),
    cost: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type QwenUsage = z.infer<typeof QwenUsageSchema>;
