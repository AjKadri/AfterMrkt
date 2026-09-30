import { createHmac } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import {
  DemoAccountSettingsSchema,
  DemoAssetsDataSchema,
  DemoOrderInfoDataSchema,
  DemoOrderListDataSchema,
  DemoPlaceOrderDataSchema,
  DemoResponseBaseSchema,
  DemoOrderSchema,
  type BitgetDemoAccountSettings,
  type BitgetDemoAsset,
  type BitgetDemoOrder,
} from '../../contracts/bitget-demo.js';
import { canonicalJson } from '../../lib/canonical.js';
import { classifyProviderFailure, classifyThrownError, ProbeError } from '../../lib/errors.js';
import { joinUrl, parseJsonBody, requestRaw, type RawHttpResponse } from '../../lib/http.js';
import { DEFAULT_BITGET_BASE_URL } from './client.js';

export type BitgetDemoCredentials = {
  apiKey: string;
  secretKey: string;
  passphrase: string;
};

export type DemoOrderIntent = {
  symbol: string;
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  quantity: string;
  price?: string;
  clientOid: string;
};

export type DemoAssetBalance = {
  asset: string;
  available: string;
  locked: string;
  total: string;
  providerTimestamp: string | null;
  receivedAt: string;
};

export type DemoOrderState = {
  orderId: string | null;
  clientOid: string;
  symbol: string | null;
  side: 'buy' | 'sell' | null;
  orderType: 'market' | 'limit' | null;
  orderStatus: string;
  requestedQuantity: string | null;
  filledQuantity: string;
  remainingQuantity: string | null;
  averageFillPrice: string | null;
  executedValue: string | null;
  fees: Array<{ coin: string | null; amount: string | null }>;
  createdTime: string | null;
  updatedTime: string | null;
  receivedAt: string;
};

export type DemoOpenOrder = DemoOrderState;

export type DemoAccountCheck = {
  status: 'verified' | 'unavailable' | 'unsupported';
  environment: 'BITGET_DEMO';
  credentialsConfigured: boolean;
  authentication: 'verified' | 'unavailable';
  assets: DemoAssetBalance[];
  settings: BitgetDemoAccountSettings | null;
  withdrawalPermission: 'present' | 'absent' | 'unknown';
  permissions: string[];
  warnings: string[];
  checkedAt: string;
};

export type DemoCapabilityResult = {
  status: 'verified' | 'unavailable' | 'unsupported';
  reason: string;
  providerSymbol: string | null;
  credentialsConfigured: boolean;
  checkedAt: string;
};

export type BitgetDemoClientOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  credentials?: BitgetDemoCredentials | null;
  now?: () => Date;
};

export interface BitgetDemoRealityAdapter {
  readonly environment: 'BITGET_DEMO';
  readonly credentialsConfigured: boolean;
  checkAccount(): Promise<DemoAccountCheck>;
  getAssets(): Promise<DemoAssetBalance[]>;
  getOpenOrders(symbol: string): Promise<DemoOpenOrder[]>;
  placeOrder(intent: DemoOrderIntent): Promise<DemoOrderState>;
  getOrderByClientOid(clientOid: string): Promise<DemoOrderState | null>;
  cancelOrder(clientOid: string): Promise<DemoOrderState | null>;
}

export class BitgetDemoClient implements BitgetDemoRealityAdapter {
  readonly environment = 'BITGET_DEMO' as const;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly credentials: BitgetDemoCredentials | null;
  readonly credentialsConfigured: boolean;
  private readonly now: () => Date;

  constructor(options: BitgetDemoClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? process.env.BITGET_BASE_URL ?? DEFAULT_BITGET_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BITGET_TIMEOUT_MS ?? 15_000);
    this.credentials = options.credentials ?? credentialsFromProcessEnv();
    this.credentialsConfigured = this.credentials !== null;
    this.now = options.now ?? (() => new Date());
  }

  async checkAccount(): Promise<DemoAccountCheck> {
    const checkedAt = this.now().toISOString();
    if (this.credentials === null) {
      return unavailableAccountCheck(
        checkedAt,
        false,
        'BITGET_DEMO credentials are incomplete or absent.',
      );
    }
    try {
      const [assets, settingsResult] = await Promise.all([
        this.getAssets(),
        this.request('/api/v3/account/settings', 'GET', undefined, {}, DemoAccountSettingsSchema),
      ]);
      const settings = settingsResult.data;
      const permissions = collectPermissionStrings(settings);
      const withdrawalPermission = inferWithdrawalPermission(settings);
      return {
        status: 'verified',
        environment: 'BITGET_DEMO',
        credentialsConfigured: true,
        authentication: 'verified',
        assets,
        settings,
        withdrawalPermission,
        permissions,
        warnings:
          withdrawalPermission === 'present'
            ? ['Withdrawal permission is present on the Demo key; it is not used by AfterMrkt.']
            : [],
        checkedAt,
      };
    } catch (error) {
      return {
        ...unavailableAccountCheck(checkedAt, true, safeProviderMessage(error)),
        status: providerUnsupported(error) ? 'unsupported' : 'unavailable',
      };
    }
  }

  async getAssets(): Promise<DemoAssetBalance[]> {
    const result = await this.request('/api/v3/account/assets', 'GET', undefined, {}, (value) =>
      parseAssets(value),
    );
    return result.data.map((asset) => normalizeAsset(asset, result.raw, result.providerTimestamp));
  }

  async getOpenOrders(symbol: string): Promise<DemoOpenOrder[]> {
    const result = await this.request(
      '/api/v3/trade/unfilled-orders',
      'GET',
      undefined,
      { category: 'SPOT', symbol, limit: '100' },
      (value) => parseOrderList(value),
    );
    return result.data.map((order) => normalizeOrder(order, result.raw));
  }

  async placeOrder(intent: DemoOrderIntent): Promise<DemoOrderState> {
    if (intent.orderType === 'limit' && intent.price === undefined) {
      throw new ProbeError('malformed_provider_data', 'limit Demo orders require a price');
    }
    const body: Record<string, unknown> = {
      category: 'SPOT',
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      qty: intent.quantity,
      clientOid: intent.clientOid,
    };
    if (intent.price !== undefined) body.price = intent.price;
    if (intent.orderType === 'limit') body.timeInForce = 'gtc';
    const result = await this.request(
      '/api/v3/trade/place-order',
      'POST',
      body,
      {},
      DemoPlaceOrderDataSchema,
    );
    try {
      const state = await this.getOrderByClientOid(result.data.clientOid);
      if (state !== null) return state;
    } catch {
      // The provider has acknowledged an order, but a failed follow-up is ambiguous.
    }
    return {
      orderId: result.data.orderId,
      clientOid: result.data.clientOid,
      symbol: intent.symbol,
      side: intent.side,
      orderType: intent.orderType,
      orderStatus: 'pending_verification',
      requestedQuantity: intent.quantity,
      filledQuantity: '0',
      remainingQuantity: intent.quantity,
      averageFillPrice: null,
      executedValue: null,
      fees: [],
      createdTime: null,
      updatedTime: null,
      receivedAt: result.raw.receivedAt,
    };
  }

  async getOrderByClientOid(clientOid: string): Promise<DemoOrderState | null> {
    const result = await this.request(
      '/api/v3/trade/order-info',
      'GET',
      undefined,
      { clientOid },
      (value) => parseOrderInfo(value),
    );
    const order = result.data;
    return order === null ? null : normalizeOrder(order, result.raw, clientOid);
  }

  async cancelOrder(clientOid: string): Promise<DemoOrderState | null> {
    await this.request(
      '/api/v3/trade/cancel-order',
      'POST',
      { category: 'SPOT', clientOid },
      {},
      z.object({
        orderId: z.union([z.string(), z.number()]).transform(String),
        clientOid: z.string(),
      }),
    );
    try {
      return await this.getOrderByClientOid(clientOid);
    } catch {
      return null;
    }
  }

  async verifyInstrument(symbol: string): Promise<DemoCapabilityResult> {
    const checkedAt = this.now().toISOString();
    if (!this.credentialsConfigured) {
      return {
        status: 'unavailable',
        reason: 'BITGET_DEMO credentials are incomplete or absent',
        providerSymbol: symbol,
        credentialsConfigured: false,
        checkedAt,
      };
    }
    try {
      await this.getOpenOrders(symbol);
      return {
        status: 'verified',
        reason: 'authenticated Demo order query accepted the exact provider symbol',
        providerSymbol: symbol,
        credentialsConfigured: true,
        checkedAt,
      };
    } catch (error) {
      return {
        status: providerUnsupported(error) ? 'unsupported' : 'unavailable',
        reason: safeProviderMessage(error),
        providerSymbol: symbol,
        credentialsConfigured: true,
        checkedAt,
      };
    }
  }

  private async request<T>(
    path: string,
    method: 'GET' | 'POST',
    body: Record<string, unknown> | undefined,
    query: Record<string, string | undefined>,
    parseData: z.ZodType<T> | ((value: unknown) => T),
  ): Promise<{ data: T; raw: RawHttpResponse; providerTimestamp: string | null }> {
    if (this.credentials === null) {
      throw new ProbeError('authentication_invalid', 'BITGET_DEMO credentials are not configured');
    }
    const url = new URL(joinUrl(this.baseUrl, path));
    const queryString = sortedQuery(query);
    if (queryString !== '') url.search = queryString;
    const serializedBody = body === undefined ? '' : canonicalJson(body);
    const timestamp = String(this.now().getTime());
    const signature = buildBitgetSignature(
      timestamp,
      method,
      path,
      queryString,
      serializedBody,
      this.credentials.secretKey,
    );
    let raw: RawHttpResponse;
    try {
      raw = await requestRaw(url.toString(), {
        method,
        timeoutMs: this.timeoutMs,
        ...(body === undefined ? {} : { body: serializedBody }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'AfterMrkt-demo/0.1',
          'ACCESS-KEY': this.credentials.apiKey,
          'ACCESS-SIGN': signature,
          'ACCESS-TIMESTAMP': timestamp,
          'ACCESS-PASSPHRASE': this.credentials.passphrase,
          locale: 'en-US',
          paptrading: '1',
        },
      });
    } catch (error) {
      throw new ProbeError(
        classifyThrownError(error),
        `Bitget Demo request failed: ${formatThrownError(error)}`,
      );
    }
    let json: unknown;
    try {
      json = parseJsonBody(raw.bodyText);
    } catch (error) {
      throw new ProbeError(
        classifyProviderFailure(raw.status, undefined, undefined),
        `Bitget Demo returned non-JSON data: ${error instanceof Error ? error.message : String(error)}`,
        { httpStatus: raw.status, rawResponse: raw },
      );
    }
    const base = DemoResponseBaseSchema.extend({ data: z.unknown() }).safeParse(json);
    if (!base.success) {
      throw new ProbeError('malformed_provider_data', formatZodError(base.error), {
        httpStatus: raw.status,
        rawResponse: raw,
      });
    }
    if (base.data.code !== '00000') {
      throw new ProbeError(
        classifyProviderFailure(raw.status, base.data.code, base.data.msg),
        `Bitget Demo provider error ${base.data.code}: ${base.data.msg}`,
        {
          httpStatus: raw.status,
          providerCode: base.data.code,
          providerMessage: base.data.msg,
          rawResponse: raw,
        },
      );
    }
    try {
      const parsed =
        typeof parseData === 'function'
          ? parseData(base.data.data)
          : parseData.parse(base.data.data);
      return { data: parsed, raw, providerTimestamp: base.data.requestTime ?? null };
    } catch (error) {
      if (error instanceof ProbeError) {
        throw new ProbeError(error.status, error.message, {
          httpStatus: raw.status,
          providerCode: error.providerCode,
          providerMessage: error.providerMessage,
          rawResponse: raw,
        });
      }
      const zodError = error instanceof z.ZodError ? error : null;
      throw new ProbeError(
        'malformed_provider_data',
        zodError ? formatZodError(zodError) : String(error),
        {
          httpStatus: raw.status,
          rawResponse: raw,
        },
      );
    }
  }
}

export function credentialsFromProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
): BitgetDemoCredentials | null {
  const apiKey = env.BITGET_DEMO_API_KEY?.trim();
  const secretKey = env.BITGET_DEMO_API_SECRET?.trim();
  const passphrase = env.BITGET_DEMO_PASSPHRASE?.trim();
  return apiKey && secretKey && passphrase ? { apiKey, secretKey, passphrase } : null;
}

export function buildBitgetSignature(
  timestamp: string,
  method: string,
  requestPath: string,
  queryString: string,
  body: string,
  secretKey: string,
): string {
  const payload = `${timestamp}${method.toUpperCase()}${requestPath}${queryString === '' ? '' : `?${queryString}`}${body}`;
  return createHmac('sha256', secretKey).update(payload, 'utf8').digest('base64');
}

export const demoRealityAdapterBoundary = Object.freeze({
  environment: 'BITGET_DEMO' as const,
  header: 'paptrading: 1',
  orderEndpoint: '/api/v3/trade/place-order',
  reason:
    'Demo-only authenticated UTA Reality order boundary. Live credentials are never accepted.',
});

function parseAssets(value: unknown): BitgetDemoAsset[] {
  const parsed = DemoAssetsDataSchema.safeParse(value);
  if (!parsed.success)
    throw new ProbeError('malformed_provider_data', formatZodError(parsed.error));
  if (Array.isArray(parsed.data)) return parsed.data;
  if ('assets' in parsed.data) return parsed.data.assets as BitgetDemoAsset[];
  return parsed.data.list;
}

function parseOrderList(value: unknown): BitgetDemoOrder[] {
  const parsed = DemoOrderListDataSchema.safeParse(value);
  if (!parsed.success)
    throw new ProbeError('malformed_provider_data', formatZodError(parsed.error));
  return parsed.data.list;
}

function parseOrderInfo(value: unknown): BitgetDemoOrder | null {
  if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) {
    return null;
  }
  if (value !== null && typeof value === 'object' && 'list' in value) {
    const listParsed = z.object({ list: z.array(DemoOrderSchema) }).safeParse(value);
    if (!listParsed.success)
      throw new ProbeError('malformed_provider_data', formatZodError(listParsed.error));
    return listParsed.data.list[0] ?? null;
  }
  const parsed = DemoOrderInfoDataSchema.safeParse(value);
  if (!parsed.success) {
    if (value !== null && typeof value === 'object' && Object.keys(value).length === 0) return null;
    throw new ProbeError('malformed_provider_data', formatZodError(parsed.error));
  }
  return parsed.data as BitgetDemoOrder;
}

function normalizeAsset(
  asset: BitgetDemoAsset,
  raw: RawHttpResponse,
  providerTimestamp: string | null,
): DemoAssetBalance {
  const available = asset.available ?? asset.availableBalance ?? '0';
  const locked = asset.locked ?? asset.frozen ?? '0';
  const total =
    asset.total ?? asset.balance ?? asset.equity ?? sumDecimalStrings(available, locked);
  return {
    asset: asset.coin,
    available,
    locked,
    total,
    providerTimestamp,
    receivedAt: raw.receivedAt,
  };
}

function sumDecimalStrings(left: string, right: string): string {
  try {
    return new Decimal(left).plus(new Decimal(right)).toFixed();
  } catch {
    return '0';
  }
}

function normalizeOrder(
  order: BitgetDemoOrder,
  raw: RawHttpResponse,
  fallbackClientOid?: string,
): DemoOrderState {
  const requestedQuantity = order.qty ?? null;
  const filledQuantity = order.cumExecQty ?? '0';
  return {
    orderId: order.orderId ?? null,
    clientOid: order.clientOid ?? fallbackClientOid ?? '',
    symbol: order.symbol ?? null,
    side: order.side === 'buy' || order.side === 'sell' ? order.side : null,
    orderType: order.orderType === 'market' || order.orderType === 'limit' ? order.orderType : null,
    orderStatus: order.orderStatus ?? 'unknown',
    requestedQuantity,
    filledQuantity,
    remainingQuantity:
      requestedQuantity === null ? null : subtractDecimalStrings(requestedQuantity, filledQuantity),
    averageFillPrice: order.avgPrice ?? null,
    executedValue: order.cumExecValue ?? null,
    fees: normalizeFees(order.feeDetail),
    createdTime: order.createdTime ?? null,
    updatedTime: order.updatedTime ?? null,
    receivedAt: raw.receivedAt,
  };
}

function normalizeFees(
  fees: Array<Record<string, unknown>> | undefined,
): Array<{ coin: string | null; amount: string | null }> {
  return (fees ?? []).map((fee) => ({
    coin: stringValue(fee.feeCoin ?? fee.coin),
    amount: stringValue(fee.fee ?? fee.amount),
  }));
}

function subtractDecimalStrings(left: string, right: string): string {
  try {
    const leftParts = left.split('.');
    const rightParts = right.split('.');
    const scale = Math.max(leftParts[1]?.length ?? 0, rightParts[1]?.length ?? 0);
    const leftInt = BigInt(`${leftParts[0] ?? '0'}${(leftParts[1] ?? '').padEnd(scale, '0')}`);
    const rightInt = BigInt(`${rightParts[0] ?? '0'}${(rightParts[1] ?? '').padEnd(scale, '0')}`);
    const result = leftInt - rightInt;
    const negative = result < 0n;
    const absolute = (negative ? -result : result).toString().padStart(scale + 1, '0');
    if (scale === 0) return `${negative ? '-' : ''}${absolute}`;
    return `${negative ? '-' : ''}${absolute.slice(0, -scale)}.${absolute.slice(-scale)}`.replace(
      /\.0+$/,
      '',
    );
  } catch {
    return left;
  }
}

function sortedQuery(query: Record<string, string | undefined>): string {
  return new URLSearchParams(
    Object.entries(query)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  ).toString();
}

function collectPermissionStrings(value: BitgetDemoAccountSettings): string[] {
  return Object.entries(value)
    .filter(
      ([key, item]) => /permission|perm|trade|withdraw/i.test(key) && typeof item === 'string',
    )
    .map(([key, item]) => `${key}=${String(item)}`);
}

function inferWithdrawalPermission(
  value: BitgetDemoAccountSettings,
): DemoAccountCheck['withdrawalPermission'] {
  for (const [key, item] of Object.entries(value)) {
    if (!/withdraw/i.test(key)) continue;
    if (item === true || item === 'true' || item === 'yes' || item === '1') return 'present';
    if (item === false || item === 'false' || item === 'no' || item === '0') return 'absent';
  }
  return 'unknown';
}

function unavailableAccountCheck(
  checkedAt: string,
  credentialsConfigured: boolean,
  warning: string,
): DemoAccountCheck {
  return {
    status: 'unavailable',
    environment: 'BITGET_DEMO',
    credentialsConfigured,
    authentication: 'unavailable',
    assets: [],
    settings: null,
    withdrawalPermission: 'unknown',
    permissions: [],
    warnings: [warning],
    checkedAt,
  };
}

function providerUnsupported(error: unknown): boolean {
  return (
    error instanceof ProbeError &&
    (error.status === 'whitelist_denied' || error.status === 'provider_rejected')
  );
}

function safeProviderMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

function formatThrownError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = 'cause' in error ? error.cause : undefined;
  if (cause instanceof Error) return `${error.message}; cause=${cause.message}`;
  if (typeof cause === 'object' && cause !== null && 'code' in cause) {
    return `${error.message}; cause=${String(cause.code)}`;
  }
  return error.message;
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}
