/**
 * Diagnostic probe: runs the real simulation route with the decision stress test
 * enabled and records what Qwen returned and why validation accepted or rejected it.
 * Writes .agent/evidence/stress-diagnose/result.json. No API key is stored.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { BitgetPublicMarketDataAdapter } from '../../src/adapters/bitget/index.js';
import {
  QwenClient,
  type QwenCall,
  type QwenDecisionStressTestPacket,
  type QwenWorkspaceQuestionPacket,
} from '../../src/adapters/qwen/index.js';
import { createApiServer } from '../../src/api/index.js';
import { loadLocalEnv } from '../../src/lib/env.js';

loadLocalEnv();

const symbol = process.env.STRESS_DIAGNOSE_SYMBOL ?? 'RNVDAUSDT';
const quantities = ['5', '30', '400'];
const real = new QwenClient();
const calls: Record<string, unknown>[] = [];
const questionCalls: Record<string, unknown>[] = [];

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const wrapped = {
  model: real.model,
  async stressTestDecision(packet: QwenDecisionStressTestPacket): Promise<QwenCall> {
    const started = Date.now();
    try {
      const call = await real.stressTestDecision(packet);
      calls.push({
        latencyMs: Date.now() - started,
        configuredModel: real.model,
        providerReportedModel: call.providerReportedModel ?? null,
        content: call.content,
        packet,
      });
      return call;
    } catch (error) {
      calls.push({ latencyMs: Date.now() - started, providerError: describe(error), packet });
      throw error;
    }
  },
  async askWorkspaceQuestion(packet: QwenWorkspaceQuestionPacket): Promise<QwenCall> {
    const started = Date.now();
    try {
      const call = await real.askWorkspaceQuestion(packet);
      questionCalls.push({
        question: packet.question,
        latencyMs: Date.now() - started,
        providerReportedModel: call.providerReportedModel ?? null,
        retryInstruction: packet.retryInstruction ?? null,
        content: call.content,
      });
      return call;
    } catch (error) {
      questionCalls.push({
        question: packet.question,
        latencyMs: Date.now() - started,
        providerError: describe(error),
      });
      throw error;
    }
  },
};

const server = createApiServer({ marketData: new BitgetPublicMarketDataAdapter(), qwen: wrapped });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;

const results: Record<string, unknown>[] = [];
let bookSnapshotId: string | null = null;
for (const quantity of quantities) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/execution/simulations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, quantity, includeDecisionStressTest: true }),
    });
    const body = (await response.json()) as {
      data?: { bookSnapshotId?: string; decisionStressTest?: { status?: string; reason?: string } };
      error?: unknown;
    };
    if (quantity === '30' && body.data?.bookSnapshotId) bookSnapshotId = body.data.bookSnapshotId;
    results.push({
      quantity,
      http: response.status,
      stressStatus: body.data?.decisionStressTest?.status ?? null,
      stressReason: body.data?.decisionStressTest?.reason ?? null,
      error: body.error ?? null,
    });
  } catch (error) {
    results.push({ quantity, requestError: describe(error) });
  }
}

const questions = [
  'What would exiting my position cost me?',
  'How deep is the order book for my size?',
  'Why did this move?',
  'Should I sell now?',
];
const questionResults: Record<string, unknown>[] = [];
for (const question of questions) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/assistant/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        symbol,
        question,
        ...(bookSnapshotId === null ? {} : { snapshotId: bookSnapshotId }),
        quantity: '30',
      }),
    });
    const body = (await response.json()) as {
      data?: {
        status?: string;
        attemptCount?: number;
        reason?: string;
        answer?: string;
        uncertainties?: string[];
      };
      error?: unknown;
    };
    questionResults.push({
      question,
      http: response.status,
      status: body.data?.status ?? null,
      attemptCount: body.data?.attemptCount ?? null,
      reason: body.data?.reason ?? null,
      answer: body.data?.answer ?? null,
      uncertainties: body.data?.uncertainties ?? null,
      error: body.error ?? null,
    });
  } catch (error) {
    questionResults.push({ question, requestError: describe(error) });
  }
}
server.close();

const directory = join(process.cwd(), '.agent', 'evidence', 'stress-diagnose');
mkdirSync(directory, { recursive: true });
const file = join(directory, 'result.json');
writeFileSync(
  file,
  JSON.stringify(
    { symbol, ranAt: new Date().toISOString(), results, calls, questionResults, questionCalls },
    null,
    2,
  ),
);
for (const result of results) {
  console.log(
    `stress ${String(result.quantity)}: ${String(result.stressStatus ?? result.requestError ?? JSON.stringify(result.error))} ${String(result.stressReason ?? '')}`,
  );
}
for (const result of questionResults) {
  console.log(
    `question "${String(result.question)}": ${String(result.status ?? result.requestError ?? JSON.stringify(result.error))} ${String(result.reason ?? '')}`,
  );
}
console.log(`Wrote ${file}`);
process.exit(0);
