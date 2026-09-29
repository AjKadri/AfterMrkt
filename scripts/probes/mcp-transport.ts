import { promises as dns } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { join } from 'node:path';
import { McpClient } from '../../src/adapters/mcp/index.js';
import { requestRaw } from '../../src/lib/http.js';
import { writeTextFile } from '../../src/observability/evidence.js';
import { createEvidenceDirectory } from './common.js';

const endpoint = process.env.MCP_ENDPOINT ?? 'https://agent.bitget.com/mcp';
const parsed = new URL(endpoint);
const startedAt = new Date().toISOString();
const evidenceDirectory = await createEvidenceDirectory('mcp-transport');
const dnsResult = await resolveHost(parsed.hostname);
const tcpResult = await probeTcp(parsed.hostname, Number(parsed.port || 443));
const tlsResult = await probeTls(parsed.hostname, Number(parsed.port || 443));
const httpResult = await probeHttp(endpoint);
const mcpResult = httpResult.ok
  ? await probeMcp(endpoint)
  : { ok: false, error: 'skipped because HTTP transport did not complete' };
const report = {
  endpoint,
  host: parsed.hostname,
  port: Number(parsed.port || 443),
  startedAt,
  completedAt: new Date().toISOString(),
  layers: { dns: dnsResult, tcp: tcpResult, tls: tlsResult, http: httpResult, mcp: mcpResult },
};
const reportPath = join(evidenceDirectory, 'transport-report.json');
await writeTextFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ evidenceDirectory, reportPath, ...report }, null, 2));

async function resolveHost(host: string): Promise<Record<string, unknown>> {
  try {
    const addresses = await dns.lookup(host, { all: true });
    return { ok: true, addresses };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function probeTcp(host: string, port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, 5_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve({ ok: true });
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({ ok: false, error: formatError(error) });
    });
  });
}

function probeTls(host: string, port: number): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: true });
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, error: 'timeout' });
    }, 5_000);
    socket.once('secureConnect', () => {
      clearTimeout(timeout);
      const protocol = socket.getProtocol();
      socket.end();
      resolve({ ok: true, protocol });
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      socket.destroy();
      resolve({ ok: false, error: formatError(error) });
    });
  });
}

async function probeHttp(url: string): Promise<Record<string, unknown> & { ok: boolean }> {
  try {
    const raw = await requestRaw(url, {
      method: 'GET',
      timeoutMs: 5_000,
      headers: { accept: 'application/json', 'user-agent': 'AfterMrkt-mcp-transport-probe/0.1' },
    });
    return { ok: true, status: raw.status, headers: raw.headers };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

async function probeMcp(url: string): Promise<Record<string, unknown> & { ok: boolean }> {
  try {
    const client = new McpClient({ endpoint: url, timeoutMs: 5_000 });
    const result = await client.initialize();
    return { ok: true, status: result.raw.status, response: result.response };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code ? `${error.message} (${code})` : error.message;
}
