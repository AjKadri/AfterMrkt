import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  QwenClient,
  parseQwenEvent,
  type QwenThinkingMode,
} from '../../src/adapters/qwen/index.js';
import { hashRawResponse, writeTextFile } from '../../src/observability/evidence.js';
import { ProbeError, classifyThrownError } from '../../src/lib/errors.js';
import { createEvidenceDirectory } from './common.js';

const timeoutMs = 60_000;
const packet = {
  providerSymbol: 'RMUUSDT',
  nativeTicker: 'MU',
  verifiedCompanyName: 'Micron Technology',
  sourceName: 'SEC EDGAR primary filing document',
  sourceUrl: 'https://www.sec.gov/Archives/edgar/data/723125/example.htm',
  sourceAvailableAt: '2026-08-26T20:06:55.000Z',
  title: '8-K filing for MU',
  relevantItemId: '2.02',
  boundedExcerpt:
    'Item 2.02 Results of Operations and Financial Condition. The registrant announced quarterly results in the supplied filing excerpt.',
  excerptStartOffset: 0,
  excerptEndOffset:
    'Item 2.02 Results of Operations and Financial Condition. The registrant announced quarterly results in the supplied filing excerpt.'
      .length,
};

const evidenceDirectory = await createEvidenceDirectory('qwen-thinking');
const calls = [
  await runAttempt(
    'provider-default',
    new QwenClient({ thinkingMode: 'provider-default', timeoutMs }),
  ),
  await runAttempt('disabled', new QwenClient({ thinkingMode: 'disabled', timeoutMs })),
];

const report = {
  reportType: 'aftermrkt-qwen-thinking-comparison',
  generatedAt: new Date().toISOString(),
  requestedModel: 'qwen3.8-max',
  timeoutMs,
  responseFormat: 'strict-json-schema',
  sameBoundedPacket: true,
  calls,
};
const outputPath = join(evidenceDirectory, 'comparison.json');
await mkdir(evidenceDirectory, { recursive: true });
await writeTextFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, calls }, null, 2));

async function runAttempt(
  thinkingMode: QwenThinkingMode,
  client: QwenClient,
): Promise<Record<string, unknown>> {
  const startedAt = new Date().toISOString();
  try {
    const result = await client.analyzeEvidence(packet);
    let schemaValid = false;
    try {
      parseQwenEvent(result.content);
      schemaValid = true;
    } catch {
      schemaValid = false;
    }
    return {
      thinkingMode,
      startedAt,
      status: 'completed',
      requestedModel: result.model,
      providerReportedModel: result.providerReportedModel,
      latencyMs: result.latencyMs,
      schemaValid,
      usage: {
        inputTokens: result.accounting.inputTokens,
        reasoningTokens: result.accounting.reasoningTokens,
        outputTokens: result.accounting.outputTokens,
        totalTokens: result.accounting.totalTokens,
        cachedTokens: result.accounting.cachedTokens,
        providerReportedCostUsd: result.accounting.providerReportedCostUsd,
        estimatedCostUsd: result.accounting.estimatedCostUsd,
        pricingSource: result.accounting.pricingSource,
        providerUsageFields: result.usage === null ? [] : Object.keys(result.usage).sort(),
      },
      rawResponseHash: hashRawResponse(result.raw.bodyText),
    };
  } catch (error) {
    const probeError = error instanceof ProbeError ? error : undefined;
    return {
      thinkingMode,
      startedAt,
      status: probeError?.status ?? classifyThrownError(error),
      httpStatus: probeError?.httpStatus ?? probeError?.rawResponse?.status ?? null,
      providerCode: probeError?.providerCode ?? null,
    };
  }
}
