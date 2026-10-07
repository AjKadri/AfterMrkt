/**
 * Discovery probe for Bitget's US-equities MCP server. Walks the catalog with `guide`,
 * then tries the entries that look like real-time quotes for one ticker with `do_query`.
 * Prints compact output and writes .agent/evidence/mcp-discover/result.json.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpClient } from '../../src/adapters/mcp/index.js';
import { loadLocalEnv } from '../../src/lib/env.js';

loadLocalEnv();

const ticker = process.env.MCP_NATIVE_TICKER ?? 'NVDA';
const client = new McpClient();
const log: Record<string, unknown>[] = [];

const describe = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function textOf(response: unknown): string {
  const record = response as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
  const parts = record.result?.content?.map((item) => item.text ?? '').filter(Boolean) ?? [];
  if (parts.length > 0) return parts.join('\n');
  return JSON.stringify(record.result ?? record.error ?? response);
}

async function call(name: string, args: Record<string, unknown>, limit: number): Promise<string> {
  try {
    const result = await client.callTool(name, args);
    const text = textOf(result.response);
    log.push({ name, args, text });
    console.log(`\n=== ${name} ${JSON.stringify(args)} (${text.length} chars)`);
    console.log(text.slice(0, limit));
    return text;
  } catch (error) {
    log.push({ name, args, error: describe(error) });
    console.log(`\n=== ${name} ${JSON.stringify(args)} FAILED: ${describe(error)}`);
    return '';
  }
}

await client.initialize();
await client.initialized();

const root = await call('guide', {}, 2500);
const found = new Set<string>();
const collect = (text: string): void => {
  for (const match of text.matchAll(/"(?:entry_id|id)"\s*:\s*"([^"]+)"/gu)) {
    if (match[1]) found.add(match[1]);
  }
};
collect(root);
for (const keyword of ['quote', 'price', 'realtime']) {
  collect(await call('guide', { keyword }, 2500));
}

const candidates = [...found]
  .filter((id) => /quote|real.?time|snapshot|last.?price|ticker/iu.test(id))
  .slice(0, 4);
console.log(`\ncandidate quote entries: ${JSON.stringify(candidates)}`);
console.log(`all entry ids seen (${found.size}): ${JSON.stringify([...found].slice(0, 80))}`);

for (const entryId of candidates) {
  for (const params of [{ symbol: ticker }, { ticker }, { symbols: [ticker] }]) {
    const text = await call('do_query', { entry_id: entryId, params }, 1500);
    if (text !== '' && !/error|invalid|missing|required/iu.test(text.slice(0, 300))) break;
  }
}

const directory = join(process.cwd(), '.agent', 'evidence', 'mcp-discover');
mkdirSync(directory, { recursive: true });
writeFileSync(
  join(directory, 'result.json'),
  JSON.stringify({ ticker, ranAt: new Date().toISOString(), log }, null, 2),
);
console.log(`\nWrote ${join(directory, 'result.json')}`);
process.exit(0);
