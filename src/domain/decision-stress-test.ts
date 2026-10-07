import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import {
  parseQwenDecisionStressTest,
  QWEN_DECISION_STRESS_PROMPT_VERSION,
  type QwenCall,
  type QwenDecisionStressTestPacket,
} from '../adapters/qwen/index.js';
import { ProbeError } from '../lib/errors.js';
import { allowedNumberSet, formatFactForQwen } from '../lib/qwen-numbers.js';
import type { ExitSimulation } from './market-quality.js';
import type { QwenDecisionStressTest } from '../contracts/qwen.js';

export type DecisionStressTestClient = {
  model: string;
  stressTestDecision(input: QwenDecisionStressTestPacket): Promise<QwenCall>;
};

export type DecisionStressTestInput = QwenDecisionStressTestPacket & {
  processedAt: string;
};

export type DecisionStressTestResult =
  | {
      status: 'available';
      stressTestId: string;
      immediateExit: string;
      evidence: string;
      mainUncertainty: string;
      considerations: string[];
      model: string;
      providerReportedModel: string | null;
      promptVersion: string;
      processedAt: string;
      inputHash: string;
    }
  | {
      status: 'unavailable';
      reason: string;
      model: string;
      providerReportedModel: string | null;
      promptVersion: string;
      processedAt: string;
      inputHash: string;
    };

type StressFailureKind =
  'too_long' | 'ungrounded_number' | 'recommendation' | 'malformed' | 'model_mismatch';

class StressTestValidationError extends Error {
  constructor(
    readonly kind: StressFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'StressTestValidationError';
  }
}

const RETRY_INSTRUCTIONS: Partial<Record<StressFailureKind, string>> = {
  too_long:
    'The previous answer was too long. Keep immediateExit under 320 characters, evidence under 420, mainUncertainty under 260, each consideration under 170, and at most 3 considerations.',
  ungrounded_number:
    'The previous answer used a number that is not in the supplied facts. Use only numbers copied exactly from the supplied facts, or none.',
  recommendation:
    'The previous answer used recommendation or action language. Rewrite it as neutral trade-off context without telling the trader what to do.',
  malformed:
    'Return only the required JSON object with every required field exactly once, within the length limits.',
};

export type StressPacketSimulation = Pick<
  ExitSimulation,
  | 'spreadBps'
  | 'requestedQuantity'
  | 'filledQuantity'
  | 'unfilledQuantity'
  | 'positionPercentageWithin50Bps'
  | 'estimatedVWAP'
  | 'slippageVersusMidpointBps'
  | 'estimatedFee'
  | 'netExpectedProceeds'
  | 'takerFeeRate'
>;

/** Rounds every numeric packet field for display; the model never sees raw 100-digit decimals. */
export function formatStressPacketNumbers(
  simulation: StressPacketSimulation,
  movePercent: string | null,
): Pick<
  QwenDecisionStressTestPacket,
  | 'moveSinceNativeClosePercent'
  | 'spreadBps'
  | 'requestedQuantity'
  | 'filledQuantity'
  | 'unfilledQuantity'
  | 'fillRatioWithin50Bps'
  | 'estimatedVwap'
  | 'slippageBps'
  | 'estimatedFee'
  | 'netProceeds'
  | 'takerFeeRate'
> {
  const orNull = (value: string | null, unit: Parameters<typeof formatFactForQwen>[1]) =>
    value === null ? null : formatFactForQwen(value, unit);
  return {
    moveSinceNativeClosePercent: orNull(movePercent, 'percent'),
    spreadBps: orNull(simulation.spreadBps, 'bps'),
    requestedQuantity: formatFactForQwen(simulation.requestedQuantity, 'units'),
    filledQuantity: formatFactForQwen(simulation.filledQuantity, 'units'),
    unfilledQuantity: formatFactForQwen(simulation.unfilledQuantity, 'units'),
    fillRatioWithin50Bps: formatFactForQwen(simulation.positionPercentageWithin50Bps, 'ratio'),
    estimatedVwap: orNull(simulation.estimatedVWAP, 'price'),
    slippageBps: orNull(simulation.slippageVersusMidpointBps, 'bps'),
    estimatedFee: formatFactForQwen(simulation.estimatedFee, 'quote'),
    netProceeds: formatFactForQwen(simulation.netExpectedProceeds, 'quote'),
    takerFeeRate: formatFactForQwen(simulation.takerFeeRate, 'ratio'),
  };
}

export const MAX_STRESS_LIMITATIONS = 4;

export async function runDecisionStressTest(
  client: DecisionStressTestClient,
  input: DecisionStressTestInput,
): Promise<DecisionStressTestResult> {
  const { processedAt, retryInstruction: _ignored, ...packet } = input;
  void _ignored;
  const inputHash = sha256(canonicalJson(packet));
  const allowedNumbers = allowedNumberSet([JSON.stringify(packet)]);
  let retryInstruction: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const call = await client.stressTestDecision({
        ...packet,
        ...(retryInstruction === undefined ? {} : { retryInstruction }),
      });
      let parsed: QwenDecisionStressTest;
      try {
        parsed = parseQwenDecisionStressTest(call.content, { allowedNumbers });
      } catch (error) {
        throw classifyParserError(error);
      }
      const providerReportedModel = call.providerReportedModel ?? null;
      if (
        parsed.model !== client.model ||
        (providerReportedModel !== null && providerReportedModel !== client.model)
      ) {
        throw new StressTestValidationError(
          'model_mismatch',
          'Qwen decision stress test model did not match the configured model',
        );
      }
      return toAvailableResult(parsed, providerReportedModel, client.model, processedAt, inputHash);
    } catch (error) {
      lastError = error;
      const retry =
        error instanceof StressTestValidationError ? RETRY_INSTRUCTIONS[error.kind] : undefined;
      if (attempt === 1 && retry !== undefined) {
        retryInstruction = retry;
        continue;
      }
      break;
    }
  }
  return {
    status: 'unavailable',
    reason: safeFailureReason(lastError),
    model: client.model,
    providerReportedModel: null,
    promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
    processedAt,
    inputHash,
  };
}

function classifyParserError(error: unknown): unknown {
  if (!(error instanceof ProbeError) || error.status !== 'malformed_provider_data') return error;
  const message = error.message;
  if (message.includes('numeric claim')) {
    return new StressTestValidationError('ungrounded_number', message);
  }
  if (message.includes('trading recommendation')) {
    return new StressTestValidationError('recommendation', message);
  }
  if (/too big|too long|at most \d+/iu.test(message)) {
    return new StressTestValidationError('too_long', message);
  }
  return new StressTestValidationError('malformed', message);
}

function toAvailableResult(
  parsed: QwenDecisionStressTest,
  providerReportedModel: string | null,
  configuredModel: string,
  processedAt: string,
  inputHash: string,
): DecisionStressTestResult {
  const contentHash = sha256(
    canonicalJson({
      inputHash,
      output: parsed,
      providerReportedModel,
    }),
  );
  return {
    status: 'available',
    stressTestId: contentHash,
    immediateExit: parsed.immediateExit,
    evidence: parsed.evidence,
    mainUncertainty: parsed.mainUncertainty,
    considerations: parsed.considerations,
    model: configuredModel,
    providerReportedModel,
    promptVersion: parsed.promptVersion,
    processedAt,
    inputHash,
  };
}

function safeFailureReason(error: unknown): string {
  if (error instanceof Error && error.message === 'QWEN_API_KEY is not set') {
    return 'Qwen decision stress testing is unavailable because the server has no configured Qwen key.';
  }
  const prefix = 'Qwen decision stress testing is unavailable';
  if (error instanceof StressTestValidationError) {
    const detail: Record<StressFailureKind, string> = {
      too_long: 'too long',
      ungrounded_number: 'ungrounded number',
      recommendation: 'recommendation wording',
      malformed: 'malformed output',
      model_mismatch: 'model mismatch',
    };
    return `${prefix}: the answer failed validation (${detail[error.kind]}).`;
  }
  if (error instanceof ProbeError) return `${prefix}: the provider request failed.`;
  return `${prefix} for this simulation.`;
}
