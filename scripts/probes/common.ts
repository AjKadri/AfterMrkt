import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ProbeError, classifyThrownError } from '../../src/lib/errors.js';
import { hashRawResponse, writeProbeRecord } from '../../src/observability/evidence.js';
import type { RawHttpResponse } from '../../src/lib/http.js';
import type { CapabilityResult, ProbeRecord, ProbeRequest } from '../../src/probes/types.js';

export type ProbeCapture = {
  requestUrl: string;
  raw: RawHttpResponse;
  payload: unknown;
  providerTimestamp?: string | null;
};

export type ProbeRun = {
  record: ProbeRecord;
  normalizedResponse: unknown | null;
};

export async function createEvidenceDirectory(provider: string): Promise<string> {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = join(process.cwd(), '.agent', 'evidence', provider, runId);
  await mkdir(directory, { recursive: true });
  return directory;
}

export async function executeProbe<T>(input: {
  capability: string;
  request: ProbeRequest;
  action: () => Promise<ProbeCapture>;
  normalize: (payload: unknown) => T;
  outputDirectory: string;
}): Promise<ProbeRun> {
  const startedAt = new Date().toISOString();
  let capture: ProbeCapture | undefined;
  let normalizedResponse: T | null = null;
  let capabilityResult: CapabilityResult;

  try {
    capture = await input.action();
    normalizedResponse = input.normalize(capture.payload);
    capabilityResult = {
      status: 'verified',
      reason: 'Provider response matched the runtime contract.',
      httpStatus: capture.raw.status,
    };
  } catch (error) {
    const probeError = error instanceof ProbeError ? error : undefined;
    capabilityResult = {
      status: probeError?.status ?? classifyThrownError(error),
      reason: probeError?.message ?? (error instanceof Error ? error.message : String(error)),
      ...(probeError?.httpStatus === undefined ? {} : { httpStatus: probeError.httpStatus }),
      ...(probeError?.providerCode === undefined ? {} : { providerCode: probeError.providerCode }),
      ...(probeError?.providerMessage === undefined
        ? {}
        : { providerMessage: probeError.providerMessage }),
    };
  }

  const rawResponse = capture?.raw.bodyText ?? '';
  const record: ProbeRecord = {
    capability: input.capability,
    request: input.request,
    endpoint: capture?.requestUrl ?? input.request.url,
    startedAt,
    receivedAt: capture?.raw.receivedAt ?? new Date().toISOString(),
    providerTimestamp: capture?.providerTimestamp ?? null,
    normalizedResponse,
    rawResponseHash: hashRawResponse(rawResponse),
    capabilityResult,
    ...(capture ? { rawResponse } : {}),
  };
  await writeProbeRecord(record, input.outputDirectory);
  return { record, normalizedResponse };
}

export function summarizeProbe(run: ProbeRun): {
  capability: string;
  status: string;
  reason: string;
  rawResponseHash: string;
} {
  return {
    capability: run.record.capability,
    status: run.record.capabilityResult.status,
    reason: run.record.capabilityResult.reason,
    rawResponseHash: run.record.rawResponseHash,
  };
}

export function redactForSummary(value: string | undefined): string | null {
  return value ? 'configured' : null;
}
