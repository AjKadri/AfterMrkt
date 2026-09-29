import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ProbeRecord } from '../probes/types.js';
import { sha256 } from '../lib/hash.js';

export function hashRawResponse(rawResponse: string): string {
  return sha256(rawResponse);
}

export async function writeProbeRecord(
  record: ProbeRecord,
  outputDirectory: string,
): Promise<string> {
  await mkdir(outputDirectory, { recursive: true });
  const safeCapability = record.capability.replace(/[^a-zA-Z0-9._-]+/g, '_');
  const path = join(outputDirectory, `${safeCapability}.json`);
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}
