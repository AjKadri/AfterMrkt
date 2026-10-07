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
  parseQwenDecisionStressTest,
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

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const wrapped = {
  model: real.model,
  async stressTestDecision(packet: QwenDecisionStressTestPacket): Promise<QwenCall> {
    const started = Date.now();
    try {
      const call = await real.stressTestDecision(packet);
      let validation = 'passed';
      try {
        const parsed = parseQwenDecisionStressTest(call.content);
        if (parsed.model !== real.model) validation = `model echo mismatch: ${parsed.model}`;
      } catch (error) {
        validation = describe(error);
      }
      calls.push({
        latencyMs: Date.now() - started,
        configuredModel: real.model,
        providerReportedModel: call.providerReportedModel ?? null,
        validation,
        content: call.content,
        packet,
      });
      return call;
    } catch (error) {
      calls.push({ latencyMs: Date.now() - started, providerError: describe(error), packet });
      throw error;
    }
  },
  askWorkspaceQuestion: (packet: QwenWorkspaceQuestionPacket) => real.askWorkspaceQuestion(packet),
};

const server = createApiServer({ marketData: new BitgetPublicMarketDataAdapter(), qwen: wrapped });
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address() as AddressInfo;

const results: Record<string, unknown>[] = [];
for (const quantity of quantities) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/execution/simulations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol, quantity, includeDecisionStressTest: true }),
    });
    const body = (await response.json()) as {
      data?: { decisionStressTest?: { status?: string; reason?: string } };
      error?: unknown;
    };
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
server.close();

const directory = join(process.cwd(), '.agent', 'evidence', 'stress-diagnose');
mkdirSync(directory, { recursive: true });
const file = join(directory, 'result.json');
writeFileSync(
  file,
  JSON.stringify({ symbol, ranAt: new Date().toISOString(), results, calls }, null, 2),
);
for (const [index, call] of calls.entries()) {
  console.log(`call ${index + 1}: ${String(call.validation ?? call.providerError)}`);
}
console.log(`Wrote ${file}`);
process.exit(0);
