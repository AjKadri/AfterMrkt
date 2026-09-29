import { McpClient, type McpRequestResult, type McpTool } from '../../src/adapters/mcp/index.js';
import { ProbeError } from '../../src/lib/errors.js';
import { hashRawResponse, writeProbeRecord } from '../../src/observability/evidence.js';
import type { ProbeRecord } from '../../src/probes/types.js';
import {
  createEvidenceDirectory,
  failureReason,
  failureStatus,
  redactForSummary,
} from './common.js';

const client = new McpClient();
const evidenceDirectory = await createEvidenceDirectory('mcp');
const startedAt = new Date().toISOString();
const records: ProbeRecord[] = [];
let initialize: McpRequestResult | undefined;
let tools: McpTool[] = [];
let call: McpRequestResult | undefined;
let failure: { status: string; reason: string } | undefined;

try {
  initialize = await client.initialize();
  records.push(
    toRecord(
      'mcp.initialize',
      startedAt,
      initialize,
      { protocolVersion: client.protocolVersion },
      initialize.response,
    ),
  );
  await client.initialized();
  const toolList = await client.listTools();
  tools = McpClient.extractTools(toolList.response);
  records.push(toRecord('mcp.tools-list', startedAt, toolList, {}, { tools }));

  const selectedTool = selectReadOnlyTool(tools);
  if (selectedTool) {
    const argumentsValue = readToolArguments(selectedTool.name);
    call = await client.callTool(selectedTool.name, argumentsValue);
    records.push(
      toRecord(
        `mcp.tools-call.${selectedTool.name}`,
        startedAt,
        call,
        { name: selectedTool.name, arguments: argumentsValue },
        call.response,
      ),
    );
  } else {
    failure = {
      status: 'provider_rejected',
      reason: 'tools/list returned no recognizable quote/history/news/earnings tool',
    };
  }
} catch (error) {
  const status = failureStatus(error);
  const reason = failureReason(error);
  const rawResponse = error instanceof ProbeError ? error.rawResponse : undefined;
  failure = {
    status,
    reason,
  };
  records.push({
    capability: 'mcp.initialize.failure',
    request: { method: 'POST', url: client.endpoint, body: { method: 'initialize' } },
    endpoint: rawResponse?.url ?? client.endpoint,
    startedAt,
    receivedAt: rawResponse?.receivedAt ?? new Date().toISOString(),
    providerTimestamp: null,
    normalizedResponse: { status, reason },
    rawResponseHash: hashRawResponse(rawResponse?.bodyText ?? ''),
    capabilityResult: { status, reason },
    ...(rawResponse ? { rawResponse: rawResponse.bodyText } : {}),
  });
}

for (const record of records) {
  await writeProbeRecord(record, evidenceDirectory);
}

console.log(
  JSON.stringify(
    {
      provider: 'bitget-us-equities-mcp',
      endpoint: client.endpoint,
      evidenceDirectory,
      apiKey: redactForSummary(process.env.MCP_API_KEY),
      initialize: Boolean(initialize),
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
      readOnlyCallAttempted: Boolean(call),
      failure: failure ?? null,
    },
    null,
    2,
  ),
);

function toRecord(
  capability: string,
  startedAt: string,
  result: McpRequestResult,
  body: unknown,
  normalizedResponse: unknown,
): ProbeRecord {
  return {
    capability,
    request: { method: 'POST', url: result.requestUrl, body },
    endpoint: result.requestUrl,
    startedAt,
    receivedAt: result.raw.receivedAt,
    providerTimestamp: null,
    normalizedResponse,
    rawResponseHash: hashRawResponse(result.raw.bodyText),
    capabilityResult: {
      status: 'verified',
      reason: 'MCP JSON-RPC response received.',
      httpStatus: result.raw.status,
    },
    rawResponse: result.raw.bodyText,
  };
}

function selectReadOnlyTool(toolsValue: McpTool[]): McpTool | undefined {
  const preferred = ['quote', 'histor', 'earn', 'news', 'stock', 'equity'];
  return toolsValue.find((tool) => {
    const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    return preferred.some((term) => haystack.includes(term));
  });
}

function readToolArguments(toolName: string): Record<string, string> {
  const raw = process.env.MCP_TOOL_ARGUMENTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, string>;
      }
    } catch {
      throw new Error('MCP_TOOL_ARGUMENTS must be valid JSON when provided');
    }
  }
  const tickerField = toolName.toLowerCase().includes('ticker') ? 'ticker' : 'symbol';
  return { [tickerField]: process.env.MCP_NATIVE_TICKER ?? 'MU' };
}
