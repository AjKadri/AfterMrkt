import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  QWEN_EVENT_JSON_SCHEMA,
  QWEN_PROMPT_VERSION,
  QwenClient,
  parseQwenEvent,
  type QwenCall,
  type QwenResponseFormat,
} from '../../src/adapters/qwen/index.js';
import { hashRawResponse } from '../../src/observability/evidence.js';
import { ProbeError, classifyThrownError } from '../../src/lib/errors.js';
import type { CapabilityStatus } from '../../src/probes/types.js';
import { createEvidenceDirectory } from './common.js';

const client = new QwenClient();
const sourceUrl = process.env.QWEN_SAMPLE_SOURCE_URL ?? 'https://investors.micron.com/';
const sourceText =
  process.env.QWEN_SAMPLE_TEXT ??
  'Micron Technology announced quarterly results and described demand for memory products in its public investor materials.';
const evidenceDirectory = await createEvidenceDirectory('qwen');
const schemaFormat: QwenResponseFormat = {
  type: 'json_schema',
  json_schema: QWEN_EVENT_JSON_SCHEMA,
};
const objectFormat: QwenResponseFormat = { type: 'json_object' };

type Attempt = {
  capability: string;
  responseFormat: QwenResponseFormat;
  status: CapabilityStatus;
  result?: QwenCall;
  parsed?: boolean;
  error?: {
    httpStatus: number | null;
    providerCode: string | null;
  };
};

const attempts: Attempt[] = [];

const schemaAttempt = await runAttempt(
  'qwen.chat-completions.json-schema',
  schemaFormat,
  () =>
    client.extractEvent({
      sourceUrl,
      sourceText,
      promptVersion: QWEN_PROMPT_VERSION,
      responseFormat: schemaFormat,
    }),
  true,
);

const objectAttempt = await runAttempt(
  'qwen.chat-completions.json-object-fallback',
  objectFormat,
  () =>
    client.extractEvent({
      sourceUrl,
      sourceText,
      promptVersion: QWEN_PROMPT_VERSION,
      responseFormat: objectFormat,
    }),
  true,
);

const repairSource = schemaAttempt.result ?? objectAttempt.result;
let repairAttempt: Attempt | undefined;
if (repairSource !== undefined) {
  const invalidOutput = `${repairSource.content}\nTRUNCATED_BY_CAPABILITY_SPIKE`;
  const repairFormat = schemaAttempt.result === undefined ? objectFormat : schemaFormat;
  repairAttempt = await runAttempt(
    'qwen.chat-completions.repair',
    repairFormat,
    () =>
      client.repairEvent({
        invalidOutput,
        promptVersion: QWEN_PROMPT_VERSION,
        responseFormat: repairFormat,
      }),
    true,
  );
}

const invalidModel = `${client.model}-invalid-capability-probe`;
const errorAttempt = await runAttempt(
  'qwen.chat-completions.error.invalid-model',
  objectFormat,
  () =>
    new QwenClient({
      baseUrl: client.baseUrl,
      ...(client.apiKey === undefined ? {} : { apiKey: client.apiKey }),
      model: invalidModel,
      timeoutMs: client.timeoutMs,
      responseFormat: objectFormat,
    }).extractEvent({
      sourceUrl,
      sourceText,
      promptVersion: QWEN_PROMPT_VERSION,
      responseFormat: objectFormat,
    }),
  false,
);

if (schemaAttempt.result !== undefined || objectAttempt.result !== undefined) {
  const fixture = buildFixture({ schemaAttempt, objectAttempt, repairAttempt, errorAttempt });
  const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'qwen', 'provider-contract.json');
  await mkdir(join(process.cwd(), 'tests', 'fixtures', 'qwen'), { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
}

await writeFile(
  join(evidenceDirectory, 'summary.json'),
  `${JSON.stringify(
    {
      provider: 'bitget-hackathon-qwen',
      endpoint: safeEndpoint(client.baseUrl),
      requestedModel: client.model,
      apiKeyConfigured: Boolean(client.apiKey),
      promptVersion: QWEN_PROMPT_VERSION,
      calls: attempts.map(summarizeAttempt),
      fixture: schemaAttempt.result !== undefined || objectAttempt.result !== undefined,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(
  JSON.stringify(
    {
      provider: 'bitget-hackathon-qwen',
      endpoint: safeEndpoint(client.baseUrl),
      requestedModel: client.model,
      apiKeyConfigured: Boolean(client.apiKey),
      evidenceDirectory,
      fixture:
        schemaAttempt.result !== undefined || objectAttempt.result !== undefined
          ? 'tests/fixtures/qwen/provider-contract.json'
          : null,
      calls: attempts.map(summarizeAttempt),
    },
    null,
    2,
  ),
);

async function runAttempt(
  capability: string,
  responseFormat: QwenResponseFormat,
  action: () => Promise<QwenCall>,
  validate: boolean,
): Promise<Attempt> {
  const attempt: Attempt = { capability, responseFormat, status: 'not_attempted' };
  try {
    const result = await action();
    attempt.result = result;
    attempt.status = 'verified';
    if (validate) {
      parseQwenEvent(result.content);
      attempt.parsed = true;
    }
  } catch (error) {
    attempt.status = error instanceof ProbeError ? error.status : classifyThrownError(error);
    const probeError = error instanceof ProbeError ? error : undefined;
    attempt.error = {
      httpStatus: probeError?.httpStatus ?? probeError?.rawResponse?.status ?? null,
      providerCode: probeError?.providerCode ?? null,
    };
  }
  attempts.push(attempt);
  return attempt;
}

function summarizeAttempt(attempt: Attempt): Record<string, unknown> {
  return {
    capability: attempt.capability,
    responseFormat: attempt.responseFormat.type,
    status: attempt.status,
    parsedWithLocalZod: attempt.parsed ?? false,
    ...(attempt.result === undefined
      ? { error: attempt.error ?? null }
      : {
          requestedModel: attempt.result.model,
          providerReportedModel: attempt.result.providerReportedModel,
          latencyMs: attempt.result.latencyMs,
          usage: usageSummary(attempt.result),
          rawResponseHash: hashRawResponse(attempt.result.raw.bodyText),
        }),
  };
}

function usageSummary(result: QwenCall): Record<string, unknown> {
  return {
    inputTokens: result.accounting.inputTokens,
    outputTokens: result.accounting.outputTokens,
    totalTokens: result.accounting.totalTokens,
    cachedTokens: result.accounting.cachedTokens,
    providerReportedCostUsd: result.accounting.providerReportedCostUsd,
    estimatedCostUsd: result.accounting.estimatedCostUsd,
    pricingSource: result.accounting.pricingSource,
    providerUsageFields: result.usage === null ? [] : Object.keys(result.usage).sort(),
  };
}

function buildFixture(input: {
  schemaAttempt: Attempt;
  objectAttempt: Attempt;
  repairAttempt: Attempt | undefined;
  errorAttempt: Attempt;
}): Record<string, unknown> {
  return {
    fixtureType: 'redacted-qwen-provider-contract',
    fixtureStatus: 'authenticated-capability-spike',
    provider: 'bitget-hackathon-qwen',
    endpoint: safeEndpoint(client.baseUrl),
    requestedModel: client.model,
    promptVersion: QWEN_PROMPT_VERSION,
    redaction: {
      apiKey: 'omitted',
      prompt: 'omitted',
      sourceText: 'omitted',
      rawResponse: 'omitted',
    },
    responseContract: {
      eventType: 'string',
      entities: [{ name: 'string', ticker: 'string|null' }],
      materiality: ['low', 'medium', 'high', 'unknown'],
      facts: ['string'],
      uncertainties: ['string'],
      evidenceSpans: [{ quote: 'string', start: 'integer|null', end: 'integer|null' }],
      confidence: 'number 0..1',
      sourceBound: 'boolean',
      model: 'string',
      promptVersion: 'string',
    },
    calls: {
      jsonSchema: fixtureCall(input.schemaAttempt),
      jsonObjectFallback: fixtureCall(input.objectAttempt),
      repair:
        input.repairAttempt === undefined
          ? { status: 'not_attempted' }
          : fixtureCall(input.repairAttempt),
      errorBehavior: fixtureError(input.errorAttempt),
    },
  };
}

function fixtureCall(attempt: Attempt): Record<string, unknown> {
  if (attempt.result === undefined) {
    return { status: attempt.status, error: attempt.error ?? null };
  }
  return {
    status: attempt.status,
    localZodValidation: attempt.parsed ?? false,
    requestedModel: attempt.result.model,
    providerReportedModel: attempt.result.providerReportedModel,
    latencyMs: attempt.result.latencyMs,
    usage: usageSummary(attempt.result),
  };
}

function fixtureError(attempt: Attempt): Record<string, unknown> {
  return {
    status: attempt.status,
    httpStatus: attempt.error?.httpStatus ?? null,
    providerCode: attempt.error?.providerCode ?? null,
  };
}

function safeEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname}`.replace(/\/$/, '');
  } catch {
    return 'unavailable';
  }
}
