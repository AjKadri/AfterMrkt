import type { CapabilityStatus } from '../probes/types.js';
import type { RawHttpResponse } from './http.js';

export class ProbeError extends Error {
  readonly status: CapabilityStatus;
  readonly httpStatus: number | undefined;
  readonly providerCode: string | undefined;
  readonly providerMessage: string | undefined;
  readonly rawResponse: RawHttpResponse | undefined;

  constructor(
    status: CapabilityStatus,
    message: string,
    details: {
      httpStatus?: number | undefined;
      providerCode?: string | undefined;
      providerMessage?: string | undefined;
      rawResponse?: RawHttpResponse | undefined;
    } = {},
  ) {
    super(message);
    this.name = 'ProbeError';
    this.status = status;
    this.httpStatus = details.httpStatus;
    this.providerCode = details.providerCode;
    this.providerMessage = details.providerMessage;
    this.rawResponse = details.rawResponse;
  }
}

export function classifyProviderFailure(
  httpStatus: number,
  providerCode: string | undefined,
  providerMessage: string | undefined,
): CapabilityStatus {
  const message = `${providerCode ?? ''} ${providerMessage ?? ''}`.toLowerCase();
  if (message.includes('invalid access_key') || message.includes('api key') || httpStatus === 401) {
    return 'authentication_invalid';
  }
  if (message.includes('whitelist') || message.includes('white list')) {
    return 'whitelist_denied';
  }
  if (
    message.includes('symbol') &&
    (message.includes('not found') || message.includes('invalid'))
  ) {
    return 'instrument_missing';
  }
  return 'provider_rejected';
}

export function classifyThrownError(error: unknown): CapabilityStatus {
  if (error instanceof ProbeError) {
    return error.status;
  }
  if (error instanceof SyntaxError) {
    return 'malformed_provider_data';
  }
  return 'environment_unreachable';
}
