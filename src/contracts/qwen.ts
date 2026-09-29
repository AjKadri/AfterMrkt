import { z } from 'zod';

export const QwenEntitySchema = z.object({
  name: z.string(),
  ticker: z.string().nullable(),
});

export const QwenEvidenceSpanSchema = z.object({
  quote: z.string(),
  start: z.number().int().nonnegative().optional(),
  end: z.number().int().nonnegative().optional(),
});

export const QwenEventSchema = z.object({
  eventType: z.string(),
  entities: z.array(QwenEntitySchema),
  materiality: z.enum(['low', 'medium', 'high', 'unknown']),
  facts: z.array(z.string()),
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
    cached_tokens: z.number().optional(),
    cost: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type QwenUsage = z.infer<typeof QwenUsageSchema>;
