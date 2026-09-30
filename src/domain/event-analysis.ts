import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import { ProbeError } from '../lib/errors.js';
import {
  EventAnalysisSchema,
  SourceEventSchema,
  type EventAnalysis,
  type SourceEvent,
} from '../contracts/events.js';
import {
  QWEN_ANALYSIS_PROMPT_VERSION,
  QWEN_SCHEMA_VERSION,
  parseQwenEvent,
  type QwenCall,
  type QwenEvidencePacket,
} from '../adapters/qwen/index.js';
import type { QwenEvent } from '../contracts/qwen.js';
import type { CaptureStore } from '../persistence/types.js';
import { deduplicateSourceEvents } from './event-context.js';

export type EventAnalysisClient = {
  model: string;
  analyzeEvidence(input: QwenEvidencePacket): Promise<QwenCall>;
};

export type EvidenceBindingIssue = {
  code: string;
  detail: string;
};

export type QwenUsageLedger = {
  analysisCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens: number;
  providerReportedCostUsd: string | null;
  estimatedCostUsd: string | null;
  providerCostComplete: boolean;
  estimatedCostComplete: boolean;
  limitations: string[];
};

export function buildEvidencePacket(
  event: SourceEvent,
  verifiedCompanyName: string | null = null,
): QwenEvidencePacket {
  return {
    providerSymbol: event.providerSymbol,
    nativeTicker: event.nativeTicker,
    verifiedCompanyName,
    sourceName: event.sourceName,
    sourceUrl: event.sourceUrl,
    sourceAvailableAt: event.sourceAvailableAt,
    title: event.title,
    boundedExcerpt: event.excerpt,
  };
}

export function validateEvidenceBinding(
  event: SourceEvent,
  output: QwenEvent,
): EvidenceBindingIssue[] {
  const issues: EvidenceBindingIssue[] = [];
  if (output.promptVersion !== QWEN_ANALYSIS_PROMPT_VERSION) {
    issues.push({
      code: 'prompt_version_mismatch',
      detail: output.promptVersion,
    });
  }
  const spans = new Map<string, QwenEvent['evidenceSpans'][number]>();
  for (const span of output.evidenceSpans) {
    if (spans.has(span.id)) {
      issues.push({ code: 'duplicate_evidence_span_id', detail: span.id });
      continue;
    }
    spans.set(span.id, span);
    const quoteStart = span.start;
    const quoteEnd = span.end;
    if (quoteStart !== null && quoteStart !== undefined) {
      if (
        quoteEnd === undefined ||
        quoteEnd === null ||
        quoteEnd < quoteStart ||
        event.excerpt.slice(quoteStart, quoteEnd) !== span.quote
      ) {
        issues.push({
          code: 'evidence_span_offset_mismatch',
          detail: span.id,
        });
      }
    } else if (quoteEnd !== undefined && quoteEnd !== null) {
      issues.push({ code: 'evidence_span_offset_mismatch', detail: span.id });
    } else if (!event.excerpt.includes(span.quote)) {
      issues.push({ code: 'evidence_quote_not_found', detail: span.id });
    }
  }
  if (!output.sourceBound) {
    issues.push({
      code: 'model_not_source_bound',
      detail: 'model returned sourceBound=false',
    });
  }
  for (const fact of output.facts) {
    for (const spanId of fact.evidenceSpanIds) {
      if (!spans.has(spanId)) {
        issues.push({
          code: 'fact_evidence_span_missing',
          detail: `${fact.id}:${spanId}`,
        });
      }
    }
  }
  return issues;
}

export function isTransientQwenFailure(error: unknown): boolean {
  if (!(error instanceof ProbeError)) return false;
  if (error.status === 'request_timeout' || error.status === 'rate_limited') return true;
  if (error.status === 'environment_unreachable') return true;
  return error.status === 'provider_rejected' && (error.httpStatus ?? 0) >= 500;
}

export class EventAnalysisService {
  constructor(
    private readonly store: CaptureStore,
    private readonly client: EventAnalysisClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async analyze(
    rawEvent: SourceEvent,
    verifiedCompanyName: string | null = null,
  ): Promise<EventAnalysis> {
    const event = SourceEventSchema.parse(rawEvent);
    await this.store.saveSourceEvent(event);
    const existing = await this.store.listEventAnalyses(event.eventId);
    const cached = existing
      .filter(
        (analysis) =>
          analysis.model === this.client.model &&
          analysis.promptVersion === QWEN_ANALYSIS_PROMPT_VERSION &&
          analysis.schemaVersion === QWEN_SCHEMA_VERSION,
      )
      .at(-1);
    if (cached !== undefined) return cached;

    const packet = buildEvidencePacket(event, verifiedCompanyName);
    let call: QwenCall | null = null;
    let attemptCount = 0;
    let retryReason: string | null = null;
    let lastError: unknown = null;
    while (attemptCount < 2) {
      attemptCount += 1;
      try {
        call = await this.client.analyzeEvidence(packet);
        break;
      } catch (error) {
        lastError = error;
        if (attemptCount === 1 && isTransientQwenFailure(error)) {
          retryReason = error instanceof ProbeError ? error.status : 'transient_failure';
          continue;
        }
        break;
      }
    }

    const analysis =
      call === null
        ? unavailableAnalysis({
            event,
            model: this.client.model,
            attemptCount,
            retryReason,
            errorCode: errorCode(lastError),
            validationIssues: errorCode(lastError) === null ? [] : [errorCode(lastError) as string],
            processedAt: this.now().toISOString(),
          })
        : analysisFromCall({
            event,
            call,
            attemptCount,
            retryReason,
            processedAt: this.now().toISOString(),
          });
    return this.store.saveEventAnalysis(analysis);
  }

  async analyzeMany(
    rawEvents: SourceEvent[],
    verifiedCompanyName: string | null = null,
  ): Promise<EventAnalysis[]> {
    const events = deduplicateSourceEvents(rawEvents);
    return Promise.all(events.map((event) => this.analyze(event, verifiedCompanyName)));
  }
}

export function buildQwenUsageLedger(analyses: EventAnalysis[]): QwenUsageLedger {
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cacheTokens = 0;
  let providerCostComplete = true;
  let estimatedCostComplete = true;
  let providerCost = 0n;
  let estimatedCost = 0n;
  const scale = 1_000_000_000n;
  for (const analysis of analyses) {
    inputTokens += analysis.inputTokens ?? 0;
    outputTokens += analysis.outputTokens ?? 0;
    totalTokens += analysis.totalTokens ?? 0;
    cacheTokens += analysis.cacheTokens ?? 0;
    if (analysis.providerReportedCostUsd === null) {
      providerCostComplete = false;
    } else {
      providerCost += decimalToUnits(analysis.providerReportedCostUsd, scale);
    }
    if (analysis.estimatedCost === null) {
      estimatedCostComplete = false;
    } else {
      estimatedCost += decimalToUnits(analysis.estimatedCost, scale);
    }
  }
  return {
    analysisCount: analyses.length,
    inputTokens,
    outputTokens,
    totalTokens,
    cacheTokens,
    providerReportedCostUsd: providerCostComplete ? unitsToDecimal(providerCost, scale) : null,
    estimatedCostUsd: estimatedCostComplete ? unitsToDecimal(estimatedCost, scale) : null,
    providerCostComplete,
    estimatedCostComplete,
    limitations: [
      'Provider-reported monetary cost is unavailable when the provider omits a cost field.',
      'Estimated cost is present only when trusted configured rates were supplied to the Qwen client.',
    ],
  };
}

function analysisFromCall(input: {
  event: SourceEvent;
  call: QwenCall;
  attemptCount: number;
  retryReason: string | null;
  processedAt: string;
}): EventAnalysis {
  try {
    const output = parseQwenEvent(input.call.content);
    const bindingIssues = validateEvidenceBinding(input.event, output);
    const status = bindingIssues.length === 0 ? 'validated' : 'quarantined';
    const errorCode = bindingIssues.length === 0 ? null : 'evidence_binding_failed';
    return makeAnalysis({
      event: input.event,
      call: input.call,
      output,
      status,
      attemptCount: input.attemptCount,
      retryReason: input.retryReason,
      errorCode,
      validationIssues: bindingIssues.map((issue) => `${issue.code}:${issue.detail}`),
      processedAt: input.processedAt,
    });
  } catch (error) {
    return makeAnalysis({
      event: input.event,
      call: input.call,
      output: null,
      status: 'quarantined',
      attemptCount: input.attemptCount,
      retryReason: input.retryReason,
      errorCode: errorCode(error) ?? 'malformed_provider_data',
      validationIssues: [
        error instanceof Error ? error.message : 'provider output validation failed',
      ],
      processedAt: input.processedAt,
    });
  }
}

function makeAnalysis(input: {
  event: SourceEvent;
  call: QwenCall;
  output: QwenEvent | null;
  status: EventAnalysis['status'];
  attemptCount: number;
  retryReason: string | null;
  errorCode: string | null;
  validationIssues: string[];
  processedAt: string;
}): EventAnalysis {
  const output = input.output;
  const materiality = output?.materiality ?? 'insufficient_evidence';
  const facts = output?.facts ?? [];
  const evidenceSpans = (output?.evidenceSpans ?? []).map((span) => ({
    ...span,
    start: span.start ?? null,
    end: span.end ?? null,
  }));
  const sourceBound = output?.sourceBound ?? false;
  const contentHash = canonicalJson({
    eventId: input.event.eventId,
    model: input.call.model,
    promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
    schemaVersion: QWEN_SCHEMA_VERSION,
    status: input.status,
    output,
    errorCode: input.errorCode,
    validationIssues: input.validationIssues,
  });
  return EventAnalysisSchema.parse({
    analysisId: sha256(contentHash),
    eventId: input.event.eventId,
    model: input.call.model,
    providerReportedModel: input.call.providerReportedModel,
    promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
    schemaVersion: QWEN_SCHEMA_VERSION,
    eventType: output?.eventType ?? 'unavailable',
    entities: output?.entities ?? [],
    status: input.status,
    materiality,
    facts,
    uncertainties: output?.uncertainties ?? [],
    evidenceSpans,
    confidence: output?.confidence ?? null,
    sourceBound,
    inputTokens: input.call.accounting.inputTokens,
    outputTokens: input.call.accounting.outputTokens,
    totalTokens: input.call.accounting.totalTokens,
    cacheTokens: input.call.accounting.cachedTokens,
    providerReportedCostUsd: input.call.accounting.providerReportedCostUsd,
    estimatedCost: input.call.accounting.estimatedCostUsd,
    latencyMs: input.call.latencyMs,
    processedAt: input.processedAt,
    attemptCount: input.attemptCount,
    retryReason: input.retryReason,
    errorCode: input.errorCode,
    validationIssues: input.validationIssues,
  });
}

function unavailableAnalysis(input: {
  event: SourceEvent;
  model: string;
  attemptCount: number;
  retryReason: string | null;
  errorCode: string | null;
  validationIssues: string[];
  processedAt: string;
}): EventAnalysis {
  const contentHash = canonicalJson({
    eventId: input.event.eventId,
    model: input.model,
    promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
    schemaVersion: QWEN_SCHEMA_VERSION,
    status: 'unavailable',
    errorCode: input.errorCode,
    validationIssues: input.validationIssues,
  });
  return EventAnalysisSchema.parse({
    analysisId: sha256(contentHash),
    eventId: input.event.eventId,
    model: input.model,
    providerReportedModel: null,
    promptVersion: QWEN_ANALYSIS_PROMPT_VERSION,
    schemaVersion: QWEN_SCHEMA_VERSION,
    eventType: 'unavailable',
    entities: [],
    status: 'unavailable',
    materiality: 'insufficient_evidence',
    facts: [],
    uncertainties: ['Qwen analysis was unavailable.'],
    evidenceSpans: [],
    confidence: null,
    sourceBound: false,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheTokens: null,
    providerReportedCostUsd: null,
    estimatedCost: null,
    latencyMs: null,
    processedAt: input.processedAt,
    attemptCount: input.attemptCount,
    retryReason: input.retryReason,
    errorCode: input.errorCode,
    validationIssues: input.validationIssues,
  });
}

function errorCode(error: unknown): string | null {
  if (error instanceof ProbeError) return error.status;
  return error instanceof Error ? 'analysis_error' : null;
}

function decimalToUnits(value: string, scale: bigint): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (match === null) return 0n;
  const fraction = (match[3] ?? '').padEnd(9, '0').slice(0, 9);
  const units = BigInt(match[2] ?? '0') * scale + BigInt(fraction || '0');
  return match[1] === '-' ? -units : units;
}

function unitsToDecimal(value: bigint, scale: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(9, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}
