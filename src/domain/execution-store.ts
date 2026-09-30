import type {
  ExecutionAuditEvent,
  ExecutionConfirmation,
  ExecutionIntent,
  ExecutionOrder,
  Position,
} from './execution-types.js';

export type ExecutionStore = {
  savePosition(position: Position): Promise<Position>;
  getPosition(positionId: string): Promise<Position | null>;
  listPositions(source?: Position['source']): Promise<Position[]>;
  saveIntent(intent: ExecutionIntent): Promise<ExecutionIntent>;
  getIntent(intentId: string): Promise<ExecutionIntent | null>;
  saveOrder(order: ExecutionOrder): Promise<ExecutionOrder>;
  getOrder(internalOrderId: string): Promise<ExecutionOrder | null>;
  findOrderByClientOid(clientOid: string): Promise<ExecutionOrder | null>;
  saveConfirmation(confirmation: ExecutionConfirmation): Promise<ExecutionConfirmation>;
  getConfirmation(tokenHash: string): Promise<ExecutionConfirmation | null>;
  consumeConfirmation(tokenHash: string, usedAt: string): Promise<boolean>;
  appendAudit(event: ExecutionAuditEvent): Promise<ExecutionAuditEvent>;
  listAudit(intentId?: string): Promise<ExecutionAuditEvent[]>;
};
