import { QwenClient, QWEN_PROMPT_VERSION, parseQwenEvent } from '../../src/adapters/qwen/index.js';
import { hashRawResponse, writeProbeRecord } from '../../src/observability/evidence.js';
import { ProbeError } from '../../src/lib/errors.js';
import type { ProbeRecord } from '../../src/probes/types.js';
import { createEvidenceDirectory, redactForSummary } from './common.js';

const client = new QwenClient();
const evidenceDirectory = await createEvidenceDirectory('qwen');
const sourceUrl = process.env.QWEN_SAMPLE_SOURCE_URL ?? 'https://www.sec.gov/ixviewer/doc/action';
const sourceText =
  process.env.QWEN_SAMPLE_TEXT ??
  'Micron Technology announced quarterly results and described demand for memory products in its public investor materials.';
const startedAt = new Date().toISOString();
const records: ProbeRecord[] = [];
let initial: Awaited<ReturnType<QwenClient['extractEvent']>> | undefined;
let repair: Awaited<ReturnType<QwenClient['repairEvent']>> | undefined;
let parsedEvent: unknown = null;
let failure: { status: string; reason: string } | undefined;

try {
  initial = await client.extractEvent({
    sourceUrl,
    sourceText,
    promptVersion: QWEN_PROMPT_VERSION,
  });
  records.push(toRecord('qwen.chat-completions.initial', startedAt, initial, initial.content));
  try {
    parsedEvent = parseQwenEvent(initial.content);
  } catch (error) {
    if (!(error instanceof ProbeError) || error.status !== 'malformed_provider_data') {
      throw error;
    }
    repair = await client.repairEvent({
      invalidOutput: initial.content,
      promptVersion: QWEN_PROMPT_VERSION,
    });
    records.push(toRecord('qwen.chat-completions.repair', startedAt, repair, repair.content));
    parsedEvent = parseQwenEvent(repair.content);
  }
} catch (error) {
  failure = {
    status:
      error instanceof Error && 'status' in error
        ? String((error as { status: unknown }).status)
        : 'environment_unreachable',
    reason: error instanceof Error ? error.message : String(error),
  };
}

for (const record of records) {
  await writeProbeRecord(record, evidenceDirectory);
}

console.log(
  JSON.stringify(
    {
      provider: 'qwen',
      endpoint: client.baseUrl,
      model: client.model,
      apiKey: redactForSummary(client.apiKey),
      evidenceDirectory,
      sampleSourceUrl: sourceUrl,
      promptVersion: QWEN_PROMPT_VERSION,
      initialCall: initial
        ? {
            latencyMs: initial.latencyMs,
            usage: initial.usage,
            rawResponseHash: hashRawResponse(initial.raw.bodyText),
          }
        : null,
      repairCall: repair
        ? {
            latencyMs: repair.latencyMs,
            usage: repair.usage,
            rawResponseHash: hashRawResponse(repair.raw.bodyText),
          }
        : null,
      schemaValid: parsedEvent !== null,
      failure: failure ?? null,
    },
    null,
    2,
  ),
);

function toRecord(
  capability: string,
  startedAtValue: string,
  result: Awaited<ReturnType<QwenClient['extractEvent']>>,
  content: string,
): ProbeRecord {
  return {
    capability,
    request: {
      method: 'POST',
      url: `${client.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      body: { model: client.model, response_format: { type: 'json_object' } },
    },
    endpoint: result.raw.url,
    startedAt: startedAtValue,
    receivedAt: result.raw.receivedAt,
    providerTimestamp: null,
    normalizedResponse: {
      model: result.model,
      content,
      usage: result.usage,
      latencyMs: result.latencyMs,
    },
    rawResponseHash: hashRawResponse(result.raw.bodyText),
    capabilityResult: {
      status: 'verified',
      reason: 'Qwen completion response received and locally inspected.',
      httpStatus: result.raw.status,
    },
    rawResponse: result.raw.bodyText,
  };
}
