import { ProbeError } from '../../lib/errors.js';
import { requestRaw, type RawHttpResponse } from '../../lib/http.js';

export const DEFAULT_MCP_ENDPOINT = 'https://agent.bitget.com/mcp';

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpRequestResult = {
  requestUrl: string;
  raw: RawHttpResponse;
  response: JsonRpcResponse;
};

export type McpClientOptions = {
  endpoint?: string;
  timeoutMs?: number;
  protocolVersion?: string;
};

export class McpClient {
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly protocolVersion: string;
  private nextId = 1;
  private sessionId: string | undefined;

  constructor(options: McpClientOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.MCP_ENDPOINT ?? DEFAULT_MCP_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.MCP_TIMEOUT_MS ?? 15_000);
    this.protocolVersion =
      options.protocolVersion ?? process.env.MCP_PROTOCOL_VERSION ?? '2025-06-18';
  }

  async initialize(): Promise<McpRequestResult> {
    const result = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: 'aftermrkt-capability-probe', version: '0.1.0' },
    });
    this.sessionId = result.raw.headers['mcp-session-id'];
    return result;
  }

  async initialized(): Promise<void> {
    await this.request('notifications/initialized', undefined, false);
  }

  async listTools(): Promise<McpRequestResult> {
    return this.request('tools/list', {});
  }

  async callTool(name: string, argumentsValue: unknown): Promise<McpRequestResult> {
    return this.request('tools/call', { name, arguments: argumentsValue });
  }

  static extractTools(response: JsonRpcResponse): McpTool[] {
    if (response.error) {
      throw new ProbeError(
        'provider_rejected',
        `MCP tools/list error ${response.error.code}: ${response.error.message}`,
      );
    }
    const result = asRecord(response.result);
    const tools = result?.tools;
    if (!Array.isArray(tools)) {
      throw new ProbeError(
        'malformed_provider_data',
        'MCP tools/list did not return a tools array',
      );
    }
    return tools.filter(isTool);
  }

  private async request(
    method: string,
    params: unknown,
    expectsResponse = true,
  ): Promise<McpRequestResult> {
    const id = expectsResponse ? this.nextId++ : undefined;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      ...(id === undefined ? {} : { id }),
      method,
      ...(params === undefined ? {} : { params }),
    });
    let raw: RawHttpResponse;
    try {
      raw = await requestRaw(this.endpoint, {
        method: 'POST',
        timeoutMs: this.timeoutMs,
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'user-agent': 'AfterMrkt-capability-probe/0.1',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        },
        body,
      });
    } catch (error) {
      throw new ProbeError(
        'environment_unreachable',
        `MCP request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (raw.status < 200 || raw.status >= 300) {
      throw new ProbeError('provider_rejected', `MCP HTTP ${raw.status}`, {
        httpStatus: raw.status,
      });
    }
    if (!expectsResponse) {
      return { requestUrl: this.endpoint, raw, response: { jsonrpc: '2.0' } };
    }

    const response = parseMcpResponse(raw.bodyText);
    if (response.error) {
      throw new ProbeError(
        'provider_rejected',
        `MCP error ${response.error.code}: ${response.error.message}`,
      );
    }
    return { requestUrl: this.endpoint, raw, response };
  }
}

function parseMcpResponse(bodyText: string): JsonRpcResponse {
  const trimmed = bodyText.trim();
  if (!trimmed) {
    throw new ProbeError('malformed_provider_data', 'MCP returned an empty response');
  }
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as JsonRpcResponse;
    } catch (error) {
      throw new ProbeError(
        'malformed_provider_data',
        `MCP returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean);
  const lastData = dataLines.at(-1);
  if (!lastData) {
    throw new ProbeError('malformed_provider_data', 'MCP returned an unsupported stream response');
  }
  try {
    return JSON.parse(lastData) as JsonRpcResponse;
  } catch (error) {
    throw new ProbeError(
      'malformed_provider_data',
      `MCP stream data was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function isTool(value: unknown): value is McpTool {
  const record = asRecord(value);
  return typeof record?.name === 'string';
}
