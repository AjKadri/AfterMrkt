import { QwenClient, QWEN_PROMPT_VERSION, parseQwenEvent } from '../../src/adapters/qwen/index.js';
import { hashRawResponse, writeProbeRecord } from '../../src/observability/evidence.js';
import { ProbeError } from '../../src/lib/errors.js';
import { requestRaw } from '../../src/lib/http.js';
import type { ProbeRecord } from '../../src/probes/types.js';
import {
  createEvidenceDirectory,
  failureReason,
  failureStatus,
  redactForSummary,
} from './common.js';

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
  if (!client.apiKey) {
    const connectivity = await requestRaw(
      `${client.baseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        timeoutMs: client.timeoutMs,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'AfterMrkt-capability-probe/0.1',
        },
        body: JSON.stringify({
          model: client.model,
          messages: [{ role: 'user', content: 'Return JSON.' }],
          max_tokens: 8,
        }),
      },
    );
    const status: ProbeRecord['capabilityResult']['status'] =
      connectivity.status === 401 || connectivity.status === 403
        ? 'authentication_invalid'
        : 'provider_rejected';
    const reason = `Qwen endpoint reachable; unauthenticated probe returned HTTP ${connectivity.status}.`;
    failure = { status, reason };
    records.push({
      capability: 'qwen.endpoint.connectivity',
      request: { method: 'POST', url: connectivity.url, body: { model: client.model } },
      endpoint: connectivity.url,
      startedAt,
      receivedAt: connectivity.receivedAt,
      providerTimestamp: null,
      normalizedResponse: {
        httpStatus: connectivity.status,
        headers: { 'www-authenticate': connectivity.headers['www-authenticate'] ?? null },
      },
      rawResponseHash: hashRawResponse(connectivity.bodyText),
      capabilityResult: { status, reason, httpStatus: connectivity.status },
      rawResponse: connectivity.bodyText,
    });
    throw new ProbeError(status, reason, { httpStatus: connectivity.status });
  }

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
  const status = failureStatus(error);
  const reason = failureReason(error);
  const rawResponse = error instanceof ProbeError ? error.rawResponse : undefined;
  failure = {
    status,
    reason,
  };
  if (rawResponse && records.length === 0) {
    records.push({
      capability: 'qwen.chat-completions.failure',
      request: {
        method: 'POST',
        url: `${client.baseUrl.replace(/\/+$/, '')}/chat/completions`,
        body: { model: client.model },
      },
      endpoint: rawResponse.url,
      startedAt,
      receivedAt: rawResponse.receivedAt,
      providerTimestamp: null,
      normalizedResponse: { status, reason },
      rawResponseHash: hashRawResponse(rawResponse.bodyText),
      capabilityResult: { status, reason, httpStatus: rawResponse.status },
      rawResponse: rawResponse.bodyText,
    });
  }
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
