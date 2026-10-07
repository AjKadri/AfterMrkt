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

type Entry = { id: string; label: string; paramNames: string[] };
const entries = new Map<string, Entry>();
const subcategories = new Map<string, Set<string>>();

/** Walks any JSON shape and records objects that look like catalog entries or subcategories. */
function walk(value: unknown, category: string): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, category);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  const id = [record.entry_id, record.id].find((item) => typeof item === 'string');
  if (typeof id === 'string') {
    const schema = (record.params ?? record.parameters ?? record.input_schema ?? {}) as Record<
      string,
      unknown
    >;
    const properties = (schema.properties ?? schema) as Record<string, unknown>;
    const paramNames = Array.isArray(schema)
      ? schema.map((item) => String((item as Record<string, unknown>).name ?? ''))
      : Object.keys(typeof properties === 'object' && properties !== null ? properties : {});
    entries.set(id, {
      id,
      label: `${String(record.name ?? '')} ${String(record.description ?? '')}`,
      paramNames: paramNames.filter(Boolean),
    });
  }
  const subs = record.subcategories ?? record.sub_categories;
  if (Array.isArray(subs)) {
    for (const sub of subs) {
      const key = typeof sub === 'string' ? sub : (sub as Record<string, unknown>).key;
      if (typeof key === 'string') {
        if (!subcategories.has(category)) subcategories.set(category, new Set());
        subcategories.get(category)?.add(key);
      }
    }
  }
  for (const child of Object.values(record)) walk(child, category);
}

function ingest(text: string, category: string): void {
  try {
    walk(JSON.parse(text), category);
  } catch {
    // Non-JSON text is still printed above for reading by hand.
  }
}

await call('guide', {}, 600);
for (const category of ['equity', 'etf', 'news', 'sentiment']) {
  ingest(await call('guide', { category }, 9000), category);
  for (const subcategory of subcategories.get(category) ?? []) {
    ingest(await call('guide', { category, subcategory }, 6000), category);
  }
}

console.log(`\nentries found (${entries.size}):`);
for (const entry of entries.values()) {
  console.log(
    `- ${entry.id} | ${entry.label.slice(0, 110)} | params: ${entry.paramNames.join(',')}`,
  );
}

const quoteLike = /quote|real.?time|snapshot|price|行情|报价|实时|快照|最新/iu;
const candidates = [...entries.values()]
  .filter((entry) => quoteLike.test(`${entry.id} ${entry.label}`))
  .slice(0, 5);
console.log(`\ncandidate quote entries: ${JSON.stringify(candidates.map((entry) => entry.id))}`);

for (const entry of candidates) {
  const symbolParam = entry.paramNames.find((name) => /symbol|ticker|code/iu.test(name));
  const attempts: Record<string, unknown>[] = [
    ...(symbolParam ? [{ [symbolParam]: ticker }] : []),
    { symbol: ticker },
    { ticker },
    { symbols: ticker },
  ];
  for (const params of attempts) {
    const text = await call('do_query', { entry_id: entry.id, params }, 1500);
    if (text !== '' && !/error|invalid|missing|required|unknown/iu.test(text.slice(0, 300))) break;
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
