import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import {
  parseQwenWorkspaceQuestion,
  QWEN_WORKSPACE_QUESTION_PROMPT_VERSION,
  type QwenCall,
  type QwenWorkspaceQuestionPacket,
} from '../adapters/qwen/index.js';
import { ProbeError } from '../lib/errors.js';
import { allowedNumberSet, formatFactForQwen } from '../lib/qwen-numbers.js';
import type { AfterMrktContext } from './market-context.js';
import type { ExitSimulation } from './market-quality.js';
import type { TraderDecision } from './execution-types.js';

export type WorkspaceQuestionClient = {
  model: string;
  askWorkspaceQuestion(input: QwenWorkspaceQuestionPacket): Promise<QwenCall>;
};

export type WorkspaceGroundingFact = {
  id: string;
  label: string;
  value: string | null;
  unit: 'text' | 'status' | 'price' | 'percent' | 'ratio' | 'bps' | 'units' | 'quote';
  status: 'available' | 'unavailable';
  reason: string | null;
  sourceRefIds: string[];
};

export type WorkspaceQuestionInput = {
  providerSymbol: string;
  question: string;
  context: AfterMrktContext;
  simulation: ExitSimulation | null;
  decision: TraderDecision | null;
  additionalSourceRefIds?: string[];
  processedAt: string;
};

export type WorkspaceQuestionResult = {
  status: 'answered' | 'insufficient_evidence' | 'out_of_scope' | 'unavailable';
  topic: 'move' | 'evidence' | 'liquidity' | 'exit' | 'limitations' | 'general_context';
  answer: string;
  supportingFactIds: string[];
  uncertainties: string[];
  model: string;
  providerReportedModel: string | null;
  promptVersion: string;
  processedAt: string;
  contextTimestamp: string;
  inputHash: string;
  attemptCount: number;
  reason?: string;
};

type WorkspaceQuestionValidationCode =
  | 'malformed_output'
  | 'numeric_claim'
  | 'recommendation'
  | 'unknown_fact'
  | 'missing_supporting_facts'
  | 'prompt_version'
  | 'model_mismatch'
  | 'provider_model_mismatch';

class WorkspaceQuestionValidationError extends Error {
  constructor(
    readonly code: WorkspaceQuestionValidationCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceQuestionValidationError';
  }
}

export function buildWorkspaceFactRegistry(
  input: Pick<
    WorkspaceQuestionInput,
    'context' | 'simulation' | 'decision' | 'additionalSourceRefIds'
  >,
): WorkspaceGroundingFact[] {
  const context = input.context;
  const contextSourceRefIds = [
    ...context.sourceRefs.map((source) => source.sourceId),
    ...(input.additionalSourceRefIds ?? []),
  ];
  const facts: WorkspaceGroundingFact[] = [];
  const add = (
    id: string,
    label: string,
    value: string | null,
    unit: WorkspaceGroundingFact['unit'],
    status: WorkspaceGroundingFact['status'] = value === null ? 'unavailable' : 'available',
    reason: string | null = value === null ? 'the validated value is unavailable' : null,
    sourceRefIds: string[] = contextSourceRefIds,
  ) => {
    facts.push({ id, label, value, unit, status, reason, sourceRefIds });
  };

  add('instrument', 'Instrument', context.instrument?.providerSymbol ?? null, 'text');
  add('native_ticker', 'Native ticker', context.instrument?.nativeTicker ?? null, 'text');
  add('session_state', 'Session state', context.session.status, 'status');
  add(
    'move_since_native_close',
    'Move since native close',
    context.move.percentageMove,
    'percent',
    context.move.status === 'available' ? 'available' : 'unavailable',
    context.move.reason,
  );
  add('current_price', 'Current rToken price', context.market.lastPrice, 'price');
  add('spread', 'Spread', context.market.spreadBps, 'bps');
  add('midpoint', 'Midpoint', context.market.midpoint, 'price');
  add('market_freshness', 'Market freshness', context.market.freshness.state, 'status');
  add(
    'liquidity_condition',
    'Liquidity condition',
    context.liquidityContext.condition.label,
    'status',
    context.liquidityContext.status,
    context.liquidityContext.reason,
  );
  add(
    'depth_within_50bps',
    'Observed depth within 50 bps',
    context.liquidityContext.metrics?.depth.within50Bps.notional ?? null,
    'quote',
    context.liquidityContext.metrics === null ? 'unavailable' : 'available',
    context.liquidityContext.metrics === null ? context.liquidityContext.reason : null,
  );
  add('event_status', 'Event evidence status', context.eventContext.status, 'status');
  add(
    'qualifying_event_count',
    'Qualifying source event count',
    String(context.eventContext.qualifyingEventCount),
    'units',
  );
  add(
    'native_confirmation_status',
    'Native-price confirmation',
    context.nativePriceConfirmation.status,
    'status',
  );
  add('known_limitations', 'Known limitations', context.limitations.join(' '), 'text');

  for (const event of context.eventContext.events) {
    if (event.analysisStatus !== 'validated') continue;
    for (const fact of event.facts) {
      add(
        `event_fact:${event.eventId}:${fact.id}`,
        `Validated event fact · ${event.title}`,
        fact.statement,
        'text',
        'available',
        null,
        [event.eventId],
      );
    }
  }

  if (input.simulation !== null) {
    const simulation = input.simulation;
    add(
      'requested_position_quantity',
      'Requested position quantity',
      simulation.requestedQuantity,
      'units',
    );
    add('exit_vwap', 'Exit VWAP', simulation.estimatedVWAP, 'price');
    add('exit_gross_proceeds', 'Exit gross proceeds', simulation.totalExpectedProceeds, 'quote');
    add('exit_fee', 'Exit taker fee', simulation.estimatedFee, 'quote');
    add('exit_net_proceeds', 'Exit net proceeds', simulation.netExpectedProceeds, 'quote');
    add('exit_fee_rate', 'Exit taker fee rate', simulation.takerFeeRate, 'ratio');
    add('exit_slippage', 'Exit slippage', simulation.slippageVersusMidpointBps, 'bps');
    add(
      'exit_fill_ratio',
      'Exit fill ratio within 50 bps',
      simulation.positionPercentageWithin50Bps,
      'ratio',
    );
    add('exit_unfilled_quantity', 'Exit unfilled quantity', simulation.unfilledQuantity, 'units');
    add(
      'exit_liquidity_condition',
      'Exit liquidity condition',
      simulation.condition.label,
      'status',
    );
    add('exit_book_freshness', 'Exit book freshness', simulation.freshness.state, 'status');
  } else {
    add(
      'requested_position_quantity',
      'Requested position quantity',
      null,
      'units',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_vwap',
      'Exit VWAP',
      null,
      'price',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_gross_proceeds',
      'Exit gross proceeds',
      null,
      'quote',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_fee',
      'Exit taker fee',
      null,
      'quote',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_net_proceeds',
      'Exit net proceeds',
      null,
      'quote',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_fee_rate',
      'Exit taker fee rate',
      null,
      'ratio',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_slippage',
      'Exit slippage',
      null,
      'bps',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_fill_ratio',
      'Exit fill ratio within 50 bps',
      null,
      'ratio',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_unfilled_quantity',
      'Exit unfilled quantity',
      null,
      'units',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_liquidity_condition',
      'Exit liquidity condition',
      null,
      'status',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
    add(
      'exit_book_freshness',
      'Exit book freshness',
      null,
      'status',
      'unavailable',
      'no exit simulation was supplied for this question',
    );
  }

  if (input.decision !== null) {
    add('decision_kind', 'Trader decision context', input.decision.decision, 'status');
    add('decision_environment', 'Decision environment', input.decision.environment, 'status');
    add('decision_status', 'Decision status', input.decision.status, 'status');
    add(
      'decision_quantity',
      'Decision requested quantity',
      input.decision.requestedQuantity,
      'units',
    );
  } else {
    add(
      'decision_status',
      'Decision status',
      null,
      'status',
      'unavailable',
      'no prepared trader decision is attached to this question',
    );
  }
  return facts;
}

export async function runWorkspaceQuestion(
  client: WorkspaceQuestionClient,
  input: WorkspaceQuestionInput,
): Promise<{ result: WorkspaceQuestionResult; facts: WorkspaceGroundingFact[] }> {
  const facts = buildWorkspaceFactRegistry(input);
  const inputHash = sha256(
    canonicalJson({
      providerSymbol: input.providerSymbol,
      question: input.question,
      contextTimestamp: input.context.asOf,
      facts,
    }),
  );
  const base = {
    model: client.model,
    providerReportedModel: null,
    promptVersion: QWEN_WORKSPACE_QUESTION_PROMPT_VERSION,
    processedAt: input.processedAt,
    contextTimestamp: input.context.asOf,
    inputHash,
    attemptCount: 0,
  };

  const factPacket = facts.map((fact) => ({
    id: fact.id,
    label: fact.label,
    status: fact.status,
    summary: qwenSummary(fact),
  }));
  const packet: Omit<QwenWorkspaceQuestionPacket, 'retryInstruction'> = {
    providerSymbol: input.providerSymbol,
    nativeTicker: input.context.instrument?.nativeTicker ?? null,
    configuredModel: client.model,
    question: input.question,
    contextAsOf: input.context.asOf,
    facts: factPacket,
  };
  let attemptCount = 0;
  let retryInstruction: string | undefined;
  let lastError: unknown;

  while (attemptCount < 2) {
    attemptCount += 1;
    try {
      const call = await client.askWorkspaceQuestion({
        ...packet,
        ...(retryInstruction === undefined ? {} : { retryInstruction }),
      });
      const validated = validateWorkspaceQuestionCall(
        call,
        client.model,
        facts,
        allowedNumberSet([
          input.question,
          input.providerSymbol,
          packet.nativeTicker ?? '',
          ...factPacket.flatMap((fact) => [fact.id, fact.label, fact.summary]),
        ]),
      );
      return {
        facts,
        result: {
          ...validated.parsed,
          ...base,
          status: validated.parsed.status,
          providerReportedModel: validated.providerReportedModel,
          attemptCount,
        },
      };
    } catch (error) {
      lastError = error;
      if (attemptCount === 1 && error instanceof WorkspaceQuestionValidationError) {
        const nextRetryInstruction = retryInstructionFor(
          error.code,
          facts.map((fact) => fact.id),
        );
        if (nextRetryInstruction !== null) {
          retryInstruction = nextRetryInstruction;
          continue;
        }
      }
      break;
    }
  }

  return {
    facts,
    result: {
      ...base,
      attemptCount,
      status: 'unavailable',
      topic: topicForQuestion(input.question),
      answer: 'Qwen is unavailable. Your deterministic AfterMrkt context remains available.',
      supportingFactIds: [],
      uncertainties: ['The contextual Qwen explanation could not be validated.'],
      reason: safeFailureReason(lastError),
    },
  };
}

function validateWorkspaceQuestionCall(
  call: QwenCall,
  configuredModel: string,
  facts: WorkspaceGroundingFact[],
  allowedNumbers: Set<string>,
): { parsed: ReturnType<typeof parseQwenWorkspaceQuestion>; providerReportedModel: string | null } {
  let parsed: ReturnType<typeof parseQwenWorkspaceQuestion>;
  try {
    parsed = parseQwenWorkspaceQuestion(call.content, { allowedNumbers });
  } catch (error) {
    if (error instanceof ProbeError && error.status === 'malformed_provider_data') {
      throw new WorkspaceQuestionValidationError(
        validationCodeForParserMessage(error.message),
        error.message,
      );
    }
    throw error;
  }
  const providerReportedModel = call.providerReportedModel ?? null;
  if (parsed.model !== configuredModel) {
    throw new WorkspaceQuestionValidationError(
      'model_mismatch',
      'Qwen workspace question model did not match the configured model',
    );
  }
  if (providerReportedModel !== null && providerReportedModel !== configuredModel) {
    throw new WorkspaceQuestionValidationError(
      'provider_model_mismatch',
      'Qwen provider-reported model did not match the configured model',
    );
  }
  const knownFactIds = new Set(facts.map((fact) => fact.id));
  if (parsed.supportingFactIds.some((factId) => !knownFactIds.has(factId))) {
    throw new WorkspaceQuestionValidationError(
      'unknown_fact',
      'Qwen workspace question referenced an unknown fact ID',
    );
  }
  if (parsed.status === 'answered' && parsed.supportingFactIds.length === 0) {
    throw new WorkspaceQuestionValidationError(
      'missing_supporting_facts',
      'Qwen workspace question answered without supporting facts',
    );
  }
  return { parsed, providerReportedModel };
}

function validationCodeForParserMessage(message: string): WorkspaceQuestionValidationCode {
  if (message.includes('numeric claim')) return 'numeric_claim';
  if (message.includes('trading recommendation')) return 'recommendation';
  if (message.includes('prompt version')) return 'prompt_version';
  return 'malformed_output';
}

function retryInstructionFor(
  code: WorkspaceQuestionValidationCode,
  allowedFactIds: string[],
): string | null {
  switch (code) {
    case 'numeric_claim':
      return 'The previous answer used a number that is not in the fact registry. Use only numbers copied exactly from the fact summaries, or none.';
    case 'recommendation':
      return 'The previous answer used recommendation or action language. Rewrite it as neutral research context. Do not tell the trader what to do, choose a decision, or use recommendation, buy, sell, hold, exit, execute, or order language.';
    case 'unknown_fact':
      return `Use only supportingFactIds from this exact allowed list: ${JSON.stringify(allowedFactIds)}.`;
    case 'missing_supporting_facts':
      return `Because the status is answered, include at least one supportingFactId from this exact allowed list: ${JSON.stringify(allowedFactIds)}.`;
    case 'malformed_output':
      return 'Return only the required JSON object. Keep the answer and uncertainties within the schema limits, and include every required field exactly once.';
    case 'prompt_version':
    case 'model_mismatch':
    case 'provider_model_mismatch':
      return null;
  }
}

function qwenSummary(fact: WorkspaceGroundingFact): string {
  if (fact.status === 'unavailable') {
    return `${fact.label} is unavailable: ${fact.reason ?? 'unknown reason'}.`;
  }
  if (fact.unit === 'text' || fact.unit === 'status') {
    return `${fact.label}: ${fact.value ?? ''}`;
  }
  return `${fact.label}: ${formatFactForQwen(fact.value ?? '', fact.unit)}`;
}

function topicForQuestion(question: string): WorkspaceQuestionResult['topic'] {
  if (/\b(?:evidence|event|source|catalyst|why)\b/iu.test(question)) return 'evidence';
  if (/\b(?:liquidity|depth|spread|slippage|book|fill)\b/iu.test(question)) return 'liquidity';
  if (/\b(?:exit|position|partial|full|hold)\b/iu.test(question)) return 'exit';
  if (/\b(?:uncertainty|unknown|missing|limitation|native|session)\b/iu.test(question)) {
    return 'limitations';
  }
  if (/\bmove\b/iu.test(question)) return 'move';
  return 'general_context';
}

function safeFailureReason(error: unknown): string {
  if (error instanceof Error && error.message === 'QWEN_API_KEY is not set') {
    return 'Qwen API key is not configured.';
  }
  if (error instanceof ProbeError) {
    return `Qwen provider request failed: ${error.status}.`;
  }
  if (error instanceof WorkspaceQuestionValidationError) {
    return `Qwen response failed validation: ${error.code}.`;
  }
  return 'The Qwen response did not pass the contextual research contract.';
}
