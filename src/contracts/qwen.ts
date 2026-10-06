import { z } from 'zod';

export const QwenEntitySchema = z
  .object({
    name: z.string(),
    ticker: z.string().nullable(),
  })
  .strict();

export const QwenFactSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    evidenceSpanIds: z.array(z.string().min(1)).min(1),
    supportingQuote: z.string().min(1).optional(),
  })
  .strict();

export const QwenEventSchema = z
  .object({
    eventType: z.string(),
    entities: z.array(QwenEntitySchema),
    materiality: z.enum(['material', 'possibly_material', 'not_material', 'insufficient_evidence']),
    facts: z.array(QwenFactSchema),
    uncertainties: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    sourceBound: z.boolean(),
    model: z.string(),
    promptVersion: z.string(),
  })
  .strict();

export type QwenEvent = z.infer<typeof QwenEventSchema>;

export const QwenDecisionStressTestSchema = z
  .object({
    immediateExit: z.string().min(1),
    evidence: z.string().min(1),
    mainUncertainty: z.string().min(1),
    considerations: z.array(z.string().min(1)).min(1).max(4),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
  })
  .strict();

export type QwenDecisionStressTest = z.infer<typeof QwenDecisionStressTestSchema>;

export const QwenWorkspaceQuestionSchema = z
  .object({
    status: z.enum(['answered', 'insufficient_evidence', 'out_of_scope']),
    topic: z.enum(['move', 'evidence', 'liquidity', 'exit', 'limitations', 'general_context']),
    answer: z.string().min(1).max(900),
    supportingFactIds: z.array(z.string().min(1)).max(8),
    uncertainties: z.array(z.string().min(1).max(240)).max(3),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
  })
  .strict();

export type QwenWorkspaceQuestion = z.infer<typeof QwenWorkspaceQuestionSchema>;

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
