import { z } from 'zod';

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Offsets are relative to the immutable bounded excerpt, not the full filing.
 * The source event keeps the full sanitized-document excerpt bounds separately.
 */
export const EvidenceSpanSchema = z
  .object({
    id: z.string().min(1),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    text: z.string().min(1),
    contentHash: HashSchema,
  })
  .strict();

export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;
