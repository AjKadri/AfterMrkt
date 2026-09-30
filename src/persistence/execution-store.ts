import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../lib/canonical.js';
import { sha256 } from '../lib/hash.js';
import type {
  ExecutionAuditEvent,
  ExecutionConfirmation,
  ExecutionIntent,
  ExecutionOrder,
  Position,
} from '../domain/execution-types.js';
import type { ExecutionStore } from '../domain/execution-store.js';

export class InMemoryExecutionStore implements ExecutionStore {
  private readonly positions = new Map<string, Position>();
  private readonly intents = new Map<string, ExecutionIntent>();
  private readonly orders = new Map<string, ExecutionOrder>();
  private readonly confirmations = new Map<string, ExecutionConfirmation>();
  private readonly audit: ExecutionAuditEvent[] = [];

  async savePosition(position: Position): Promise<Position> {
    const stored = freezeClone(position);
    this.positions.set(position.positionId, stored);
    return stored;
  }

  async getPosition(positionId: string): Promise<Position | null> {
    return this.positions.get(positionId) ?? null;
  }

  async listPositions(source?: Position['source']): Promise<Position[]> {
    return [...this.positions.values()].filter(
      (position) => source === undefined || position.source === source,
    );
  }

  async saveIntent(intent: ExecutionIntent): Promise<ExecutionIntent> {
    const stored = freezeClone(intent);
    this.intents.set(intent.intentId, stored);
    return stored;
  }

  async getIntent(intentId: string): Promise<ExecutionIntent | null> {
    return this.intents.get(intentId) ?? null;
  }

  async saveOrder(order: ExecutionOrder): Promise<ExecutionOrder> {
    const stored = freezeClone(order);
    this.orders.set(order.internalOrderId, stored);
    return stored;
  }

  async getOrder(internalOrderId: string): Promise<ExecutionOrder | null> {
    return this.orders.get(internalOrderId) ?? null;
  }

  async findOrderByClientOid(clientOid: string): Promise<ExecutionOrder | null> {
    return [...this.orders.values()].find((order) => order.clientOid === clientOid) ?? null;
  }

  async saveConfirmation(confirmation: ExecutionConfirmation): Promise<ExecutionConfirmation> {
    const stored = freezeClone(confirmation);
    this.confirmations.set(confirmation.tokenHash, stored);
    return stored;
  }

  async getConfirmation(tokenHash: string): Promise<ExecutionConfirmation | null> {
    return this.confirmations.get(tokenHash) ?? null;
  }

  async consumeConfirmation(tokenHash: string, usedAt: string): Promise<boolean> {
    const current = this.confirmations.get(tokenHash);
    if (current === undefined || current.usedAt !== null) return false;
    this.confirmations.set(tokenHash, freezeClone({ ...current, usedAt }));
    return true;
  }

  async appendAudit(event: ExecutionAuditEvent): Promise<ExecutionAuditEvent> {
    const stored = freezeClone(event);
    this.audit.push(stored);
    return stored;
  }

  async listAudit(intentId?: string): Promise<ExecutionAuditEvent[]> {
    return this.audit.filter((event) => intentId === undefined || event.intentId === intentId);
  }
}

export class FileExecutionStore implements ExecutionStore {
  readonly rootDirectory: string;
  private confirmationMutation: Promise<void> = Promise.resolve();

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  async savePosition(position: Position): Promise<Position> {
    await writeMutable(this.path('positions', `${sha256(position.positionId)}.json`), position);
    return freezeClone(position);
  }

  async getPosition(positionId: string): Promise<Position | null> {
    return readRecord<Position>(this.path('positions', `${sha256(positionId)}.json`));
  }

  async listPositions(source?: Position['source']): Promise<Position[]> {
    const records = await readDirectory<Position>(this.path('positions'));
    return records.filter((position) => source === undefined || position.source === source);
  }

  async saveIntent(intent: ExecutionIntent): Promise<ExecutionIntent> {
    await writeMutable(this.path('intents', `${intent.intentId}.json`), intent);
    return freezeClone(intent);
  }

  async getIntent(intentId: string): Promise<ExecutionIntent | null> {
    return readRecord<ExecutionIntent>(this.path('intents', `${intentId}.json`));
  }

  async saveOrder(order: ExecutionOrder): Promise<ExecutionOrder> {
    await writeMutable(this.path('orders', `${order.internalOrderId}.json`), order);
    return freezeClone(order);
  }

  async getOrder(internalOrderId: string): Promise<ExecutionOrder | null> {
    return readRecord<ExecutionOrder>(this.path('orders', `${internalOrderId}.json`));
  }

  async findOrderByClientOid(clientOid: string): Promise<ExecutionOrder | null> {
    const orders = await readDirectory<ExecutionOrder>(this.path('orders'));
    return orders.find((order) => order.clientOid === clientOid) ?? null;
  }

  async saveConfirmation(confirmation: ExecutionConfirmation): Promise<ExecutionConfirmation> {
    await writeMutable(this.path('confirmations', `${confirmation.tokenHash}.json`), confirmation);
    return freezeClone(confirmation);
  }

  async getConfirmation(tokenHash: string): Promise<ExecutionConfirmation | null> {
    return readRecord<ExecutionConfirmation>(this.path('confirmations', `${tokenHash}.json`));
  }

  async consumeConfirmation(tokenHash: string, usedAt: string): Promise<boolean> {
    const operation = this.confirmationMutation.then(async () => {
      const current = await this.getConfirmation(tokenHash);
      if (current === null || current.usedAt !== null) return false;
      await writeMutable(this.path('confirmations', `${tokenHash}.json`), { ...current, usedAt });
      return true;
    });
    this.confirmationMutation = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  async appendAudit(event: ExecutionAuditEvent): Promise<ExecutionAuditEvent> {
    await writeImmutable(this.path('audit', `${event.eventId}.json`), event);
    return freezeClone(event);
  }

  async listAudit(intentId?: string): Promise<ExecutionAuditEvent[]> {
    const events = await readDirectory<ExecutionAuditEvent>(this.path('audit'));
    return events
      .filter((event) => intentId === undefined || event.intentId === intentId)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  }

  private path(directory: string, filename?: string): string {
    return filename === undefined
      ? join(this.rootDirectory, directory)
      : join(this.rootDirectory, directory, filename);
  }
}

async function writeMutable(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

async function writeImmutable(path: string, value: unknown): Promise<void> {
  const existing = await readRecord<unknown>(path);
  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(value)) {
      throw new Error(`immutable execution audit conflict at ${path}`);
    }
    return;
  }
  await writeMutable(path, value);
}

async function readRecord<T>(path: string): Promise<T | null> {
  try {
    return freezeClone(JSON.parse(await readFile(path, 'utf8')) as T);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readDirectory<T>(directory: string): Promise<T[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const records: T[] = [];
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    const record = await readRecord<T>(join(directory, name));
    if (record !== null) records.push(record);
  }
  return records;
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function freezeClone<T>(value: T): T {
  const cloned = structuredClone(value);
  return deepFreeze(cloned);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
