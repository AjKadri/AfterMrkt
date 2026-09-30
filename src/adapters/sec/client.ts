import { ProbeError, classifyProviderFailure, classifyThrownError } from '../../lib/errors.js';
import { joinUrl, parseJsonBody, requestRaw, type RawHttpResponse } from '../../lib/http.js';

export const DEFAULT_SEC_BASE_URL = 'https://www.sec.gov';
export const DEFAULT_SEC_DATA_URL = 'https://data.sec.gov';
export const DEFAULT_SEC_MAX_FILING_BYTES = 2_000_000;

export type SecClientOptions = {
  baseUrl?: string;
  dataBaseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  maxFilingBytes?: number;
};

export type SecRequestResult = {
  requestUrl: string;
  raw: RawHttpResponse;
  json: unknown;
};

export type SecTextRequestResult = {
  requestUrl: string;
  raw: RawHttpResponse;
  text: string;
};

export class SecEdgarClient {
  readonly baseUrl: string;
  readonly dataBaseUrl: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly maxFilingBytes: number;

  constructor(options: SecClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.SEC_BASE_URL ?? DEFAULT_SEC_BASE_URL;
    this.dataBaseUrl = options.dataBaseUrl ?? process.env.SEC_DATA_BASE_URL ?? DEFAULT_SEC_DATA_URL;
    this.userAgent = options.userAgent ?? process.env.SEC_USER_AGENT ?? '';
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SEC_TIMEOUT_MS ?? 15_000);
    this.maxFilingBytes =
      options.maxFilingBytes ??
      Number(process.env.SEC_MAX_FILING_BYTES ?? DEFAULT_SEC_MAX_FILING_BYTES);
  }

  async get(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<SecRequestResult> {
    if (!this.userAgent.trim()) {
      throw new ProbeError(
        'provider_rejected',
        'SEC_USER_AGENT must identify AfterMrkt and a responsible contact',
      );
    }
    return this.request(this.baseUrl, path, query);
  }

  async getData(
    path: string,
    query: Record<string, string | undefined> = {},
  ): Promise<SecRequestResult> {
    if (!this.userAgent.trim()) {
      throw new ProbeError(
        'provider_rejected',
        'SEC_USER_AGENT must identify AfterMrkt and a responsible contact',
      );
    }
    return this.request(this.dataBaseUrl, path, query);
  }

  async getText(path: string): Promise<SecTextRequestResult> {
    if (!this.userAgent.trim()) {
      throw new ProbeError(
        'provider_rejected',
        'SEC_USER_AGENT must identify AfterMrkt and a responsible contact',
      );
    }
    const url = new URL(joinUrl(this.baseUrl, path));
    let raw: RawHttpResponse;
    try {
      raw = await requestRaw(url.toString(), {
        timeoutMs: this.timeoutMs,
        headers: {
          accept: 'text/html, text/plain;q=0.9, application/xhtml+xml;q=0.8',
          'user-agent': this.userAgent,
        },
      });
    } catch (error) {
      throw new ProbeError(
        classifyThrownError(error),
        `SEC filing request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw new ProbeError(
        classifyProviderFailure(raw.status, undefined, undefined),
        `SEC filing HTTP ${raw.status}`,
        { httpStatus: raw.status, rawResponse: raw },
      );
    }
    if (raw.bodyText.length > this.maxFilingBytes) {
      throw new ProbeError(
        'malformed_provider_data',
        `SEC primary filing exceeded the ${this.maxFilingBytes}-byte safety limit`,
        { httpStatus: raw.status },
      );
    }
    if (raw.bodyText.trim() === '') {
      throw new ProbeError('malformed_provider_data', 'SEC primary filing was empty', {
        httpStatus: raw.status,
      });
    }
    return { requestUrl: url.toString(), raw, text: raw.bodyText };
  }

  private async request(
    baseUrl: string,
    path: string,
    query: Record<string, string | undefined>,
  ): Promise<SecRequestResult> {
    const url = new URL(joinUrl(baseUrl, path));
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let raw: RawHttpResponse;
    try {
      raw = await requestRaw(url.toString(), {
        timeoutMs: this.timeoutMs,
        headers: {
          accept: 'application/json',
          'user-agent': this.userAgent,
        },
      });
    } catch (error) {
      throw new ProbeError(
        classifyThrownError(error),
        `SEC request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw new ProbeError(
        classifyProviderFailure(raw.status, undefined, undefined),
        `SEC HTTP ${raw.status}`,
        { httpStatus: raw.status, rawResponse: raw },
      );
    }

    try {
      return { requestUrl: url.toString(), raw, json: parseJsonBody(raw.bodyText) };
    } catch (error) {
      throw new ProbeError(
        'malformed_provider_data',
        `SEC returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        { httpStatus: raw.status, rawResponse: raw },
      );
    }
  }
}
