import { ProbeError } from '../../lib/errors.js';
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
        `Bitget request failed: ${formatThrownError(error)}`,
      );
    }

    let json: unknown;
    try {
      json = parseJsonBody(raw.bodyText);
    } catch (error) {
      throw new ProbeError(
        'malformed_provider_data',
        `Bitget returned non-JSON data: ${error instanceof Error ? error.message : String(error)}`,
        { httpStatus: raw.status, rawResponse: raw },
      );
    }

    return { requestUrl: url.toString(), raw, json };
  }
}

function formatThrownError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = 'cause' in error ? error.cause : undefined;
  if (typeof cause === 'string') {
    return `${error.message}; cause=${cause}`;
  }
  if (cause instanceof Error) {
    const code = 'code' in cause ? cause.code : undefined;
    return `${error.message}; cause=${cause.message || (typeof code === 'string' ? code : 'unknown')}`;
  }
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return `${error.message}; cause=${String(cause.code)}`;
  }
  return error.message;
}
