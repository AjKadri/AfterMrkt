import { classifyProviderFailure, ProbeError } from '../../lib/errors.js';
import { joinUrl, parseJsonBody, requestRaw, type RawHttpResponse } from '../../lib/http.js';

export const DEFAULT_BITGET_BASE_URL = 'https://api.bitget.com';

export type BitgetRequestResult = {
  requestUrl: string;
  raw: RawHttpResponse;
  json: unknown;
};

export type BitgetClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
};

export class BitgetPublicClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;

  constructor(options: BitgetClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.BITGET_BASE_URL ?? DEFAULT_BITGET_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BITGET_TIMEOUT_MS ?? 15_000);
  }

  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<BitgetRequestResult> {
    const url = new URL(joinUrl(this.baseUrl, path));
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }

    let raw: RawHttpResponse;
    try {
      raw = await requestRaw(url.toString(), {
        timeoutMs: this.timeoutMs,
        headers: {
          accept: 'application/json',
          'user-agent': 'AfterMrkt-capability-probe/0.1',
        },
      });
    } catch (error) {
      throw new ProbeError(
        'environment_unreachable',
        `Bitget request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let json: unknown;
    try {
      json = parseJsonBody(raw.bodyText);
    } catch (error) {
      throw new ProbeError(
        'malformed_provider_data',
        `Bitget returned non-JSON data: ${error instanceof Error ? error.message : String(error)}`,
        { httpStatus: raw.status },
      );
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw providerResponseError(raw.status, json);
    }

    return { requestUrl: url.toString(), raw, json };
  }
}

function providerResponseError(httpStatus: number, json: unknown): ProbeError {
  const record = asRecord(json);
  const providerCode = typeof record?.code === 'string' ? record.code : undefined;
  const providerMessage = typeof record?.msg === 'string' ? record.msg : undefined;
  return new ProbeError(
    classifyProviderFailure(httpStatus, providerCode, providerMessage),
    `Bitget HTTP ${httpStatus}: ${providerMessage ?? 'provider rejected the request'}`,
    { httpStatus, providerCode, providerMessage },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
