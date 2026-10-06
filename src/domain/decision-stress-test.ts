import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import {
  parseQwenDecisionStressTest,
  QWEN_DECISION_STRESS_PROMPT_VERSION,
  type QwenCall,
  type QwenDecisionStressTestPacket,
} from '../adapters/qwen/index.js';
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

export async function runDecisionStressTest(
  client: DecisionStressTestClient,
  input: DecisionStressTestInput,
): Promise<DecisionStressTestResult> {
  const { processedAt, ...packet } = input;
  const inputHash = sha256(canonicalJson(packet));
  try {
    const call = await client.stressTestDecision(packet);
    const parsed = parseQwenDecisionStressTest(call.content);
    return toAvailableResult(parsed, call, processedAt, inputHash);
  } catch (error) {
    return {
      status: 'unavailable',
      reason: safeFailureReason(error),
      model: client.model,
      providerReportedModel: null,
      promptVersion: QWEN_DECISION_STRESS_PROMPT_VERSION,
      processedAt,
      inputHash,
    };
  }
}

function toAvailableResult(
  parsed: QwenDecisionStressTest,
  call: QwenCall,
  processedAt: string,
  inputHash: string,
): DecisionStressTestResult {
  const contentHash = sha256(
    canonicalJson({
      inputHash,
      output: parsed,
      providerReportedModel: call.providerReportedModel,
    }),
  );
  return {
    status: 'available',
    stressTestId: contentHash,
    immediateExit: parsed.immediateExit,
    evidence: parsed.evidence,
    mainUncertainty: parsed.mainUncertainty,
    considerations: parsed.considerations,
    model: parsed.model,
    providerReportedModel: call.providerReportedModel,
    promptVersion: parsed.promptVersion,
    processedAt,
    inputHash,
  };
}

function safeFailureReason(error: unknown): string {
  if (error instanceof Error && error.message === 'QWEN_API_KEY is not set') {
    return 'Qwen decision stress testing is unavailable because the server has no configured Qwen key.';
  }
  if (error instanceof Error && error.message.length > 0) {
    return 'Qwen decision stress testing is unavailable for this simulation.';
  }
  return 'Qwen decision stress testing is unavailable for this simulation.';
}
