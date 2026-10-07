import { randomBytes } from 'node:crypto';
import Decimal from 'decimal.js';
import type { BitgetDemoRealityAdapter, DemoOrderIntent } from '../adapters/bitget/demo.js';
import type { PublicMarketDataProvider } from '../adapters/bitget/public-market-data.js';
import { sha256 } from '../lib/hash.js';
import { canonicalJson } from '../lib/canonical.js';
import { assessFreshness, DEFAULT_FRESHNESS_CONFIG } from './freshness.js';
import {
  resolveMarketQualityConfig,
  simulateExit,
  type MarketQualityConfig,
} from './market-quality.js';
import type { MarketSnapshotStore } from './snapshots.js';
import type { NormalizedRealityInstrument, OrderBookSnapshot } from './types.js';
import type { ExecutionStore } from './execution-store.js';
import type { DecisionStressTestResult } from './decision-stress-test.js';
import type {
  ConfirmationResult,
  CreatedTraderDecision,
  DemoPositionsResult,
  ExecutionIntent,
  ExecutionOrder,
  ExecutionOrderStatus,
  ExecutionOrderView,
  ExecutionValidation,
  ManualPositionInput,
  PreparedTraderDecision,
  Position,
  TraderDecision,
  TraderDecisionConfirmationResult,
  TraderDecisionKind,
} from './execution-types.js';

export const DEFAULT_EXECUTION_CONFIG = Object.freeze({
  intentTtlMs: 120_000,
  confirmationTtlMs: 120_000,
  balanceFreshMaxAgeMs: DEFAULT_FRESHNESS_CONFIG.freshMaxAgeMs,
  // A paper decision is re-reviewed only when the refreshed estimate moves by more than this.
  paperRefreshToleranceBps: '10',
});

export type ExecutionConfig = {
  intentTtlMs: number;
  confirmationTtlMs: number;
  balanceFreshMaxAgeMs: number;
  paperRefreshToleranceBps: string;
};

export type CreateExecutionIntentInput = {
  positionId: string;
  providerSymbol: string;
  orderType: 'market' | 'limit';
  requestedQuantity: string;
  limitPrice?: string;
  maximumAcceptableSlippageBps?: string;
};

export type CreatedExecutionIntent = {
  intent: ExecutionIntent;
  confirmationToken: string;
};

export type PrepareTraderDecisionInput = {
  positionId: string;
  providerSymbol: string;
  decision: TraderDecisionKind;
  requestedQuantity: string;
  simulationSnapshotId?: string;
  orderType?: 'market' | 'limit';
  limitPrice?: string;
  maximumAcceptableSlippageBps?: string;
};

export type SaveTraderDecisionInput = {
  prepared: PreparedTraderDecision;
  decisionStressTest: DecisionStressTestResult | null;
  currentPrice: string | null;
};

export type ExecutionServiceOptions = {
  marketData: PublicMarketDataProvider;
  demo: BitgetDemoRealityAdapter;
  snapshots: MarketSnapshotStore;
  store: ExecutionStore;
  now?: () => Date;
  qualityConfig?: Partial<MarketQualityConfig>;
  executionConfig?: Partial<ExecutionConfig>;
};

export type ExecutionErrorCode =
  | 'POSITION_NOT_FOUND'
  | 'INSTRUMENT_NOT_FOUND'
  | 'INSTRUMENT_OFFLINE'
  | 'INVALID_SYMBOL'
  | 'INVALID_QUANTITY'
  | 'INSUFFICIENT_POSITION'
  | 'LOCKED_POSITION'
  | 'QUANTITY_PRECISION'
  | 'MINIMUM_QUANTITY'
  | 'MINIMUM_AMOUNT'
  | 'STALE_BOOK'
  | 'INVALID_BOOK'
  | 'MAX_SLIPPAGE_EXCEEDED'
  | 'OPEN_SELL_ORDER'
  | 'DEMO_UNAVAILABLE'
  | 'DEMO_UNSUPPORTED'
  | 'MANUAL_POSITION_NOT_EXECUTABLE'
  | 'INTENT_NOT_FOUND'
  | 'INTENT_EXPIRED'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_REUSED'
  | 'DECISION_QUANTITY_MISMATCH'
  | 'DECISION_NOT_FOUND'
  | 'REFRESH_REQUIRED'
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_CANCELABLE'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_REJECTED'
  | 'INTERNAL_ERROR';

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(
    code: ExecutionErrorCode,
    message: string,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = 'ExecutionError';
    this.code = code;
    this.details = details;
  }
}

export class ExecutionService {
  private readonly marketData: PublicMarketDataProvider;
  private readonly demo: BitgetDemoRealityAdapter;
  private readonly snapshots: MarketSnapshotStore;
  private readonly store: ExecutionStore;
  private readonly now: () => Date;
  private readonly qualityConfig: MarketQualityConfig;
  private readonly config: ExecutionConfig;

  constructor(options: ExecutionServiceOptions) {
    this.marketData = options.marketData;
    this.demo = options.demo;
    this.snapshots = options.snapshots;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.qualityConfig = resolveMarketQualityConfig(options.qualityConfig);
    this.config = {
      ...DEFAULT_EXECUTION_CONFIG,
      ...options.executionConfig,
    };
  }

  async createManualPosition(input: ManualPositionInput): Promise<Position> {
    const instrument = await this.requireInstrument(input.providerSymbol);
    const quantity = decimal(input.quantity, 'quantity');
    const available = decimal(input.availableQuantity ?? input.quantity, 'availableQuantity');
    const locked = decimal(
      input.lockedQuantity ?? quantity.minus(available).toFixed(),
      'lockedQuantity',
    );
    validatePositionQuantities(quantity, available, locked);
    const asOf = this.now().toISOString();
    const position: Position = {
      positionId: sha256(
        canonicalJson({ source: 'manual', providerSymbol: instrument.providerSymbol, asOf }),
      ),
      providerSymbol: instrument.providerSymbol,
      baseCoin: requireBaseCoin(instrument),
      quantity: quantity.toFixed(),
      availableQuantity: available.toFixed(),
      lockedQuantity: locked.toFixed(),
      source: 'manual',
      environment: 'SIMULATED',
      asOf,
      isSimulated: true,
    };
    await this.store.savePosition(position);
    return position;
  }

  async getDemoPositions(): Promise<DemoPositionsResult> {
    const checkedAt = this.now().toISOString();
    const account = await this.demo.checkAccount();
    if (account.status !== 'verified') {
      return {
        environment: 'BITGET_DEMO',
        status: account.status,
        account,
        positions: [],
        warnings: account.warnings,
        checkedAt,
      };
    }
    const universe = await this.marketData.discoverRealityInstruments();
    const byBaseCoin = new Map(
      universe.data
        .filter((instrument) => instrument.baseCoin !== null)
        .map((instrument) => [instrument.baseCoin as string, instrument]),
    );
    const positions: Position[] = [];
    for (const balance of account.assets) {
      const instrument = byBaseCoin.get(balance.asset);
      if (instrument === undefined) continue;
      const available = decimal(balance.available, `asset ${balance.asset} available`);
      const locked = decimal(balance.locked, `asset ${balance.asset} locked`);
      const total = decimal(balance.total, `asset ${balance.asset} total`);
      const quantity = total.gt(0) ? total : available.plus(locked);
      if (quantity.lte(0)) continue;
      const position: Position = {
        positionId: sha256(
          canonicalJson({ source: 'demo', providerSymbol: instrument.providerSymbol }),
        ),
        providerSymbol: instrument.providerSymbol,
        baseCoin: requireBaseCoin(instrument),
        quantity: quantity.toFixed(),
        availableQuantity: available.toFixed(),
        lockedQuantity: locked.toFixed(),
        source: 'demo',
        environment: 'BITGET_DEMO',
        asOf: balance.receivedAt,
        isSimulated: false,
      };
      await this.store.savePosition(position);
      positions.push(position);
    }
    return {
      environment: 'BITGET_DEMO',
      status: 'verified',
      account,
      positions,
      warnings: account.warnings,
      checkedAt,
    };
  }

  async createIntent(input: CreateExecutionIntentInput): Promise<CreatedExecutionIntent> {
    const position = await this.store.getPosition(input.positionId);
    if (position === null) throw new ExecutionError('POSITION_NOT_FOUND', 'position was not found');
    if (position.providerSymbol !== input.providerSymbol) {
      throw new ExecutionError('INVALID_SYMBOL', 'position and intent symbols do not match');
    }
    if (position.source === 'connected_bitget') {
      throw new ExecutionError(
        'MANUAL_POSITION_NOT_EXECUTABLE',
        'connected Bitget positions are not implemented',
      );
    }
    const instrument = await this.requireInstrument(input.providerSymbol);
    const requestedQuantity = decimal(input.requestedQuantity, 'requestedQuantity');
    validateRequestedQuantity(requestedQuantity, position.availableQuantity);
    validateInstrumentQuantity(requestedQuantity, instrument);
    if (input.orderType === 'limit' && input.limitPrice === undefined) {
      throw new ExecutionError(
        'INVALID_QUANTITY',
        'limit exits require a user-supplied limit price',
      );
    }
    const limitPrice =
      input.limitPrice === undefined ? null : decimal(input.limitPrice, 'limitPrice');
    if (limitPrice !== null) validatePrice(limitPrice, instrument);
    const balance = await this.refreshBalance(position, instrument);
    const orderBook = await this.fetchFreshOrderBook(input.providerSymbol);
    const simulation = this.simulate(requestedQuantity, orderBook);
    validateSimulation(simulation, input.maximumAcceptableSlippageBps);
    validateMinimumAmount(
      requestedQuantity,
      instrument,
      limitPrice?.toFixed() ?? simulation.bestBid,
    );
    const openOrders = await this.refreshOpenSellOrders(position, input.providerSymbol);
    if (openOrders > 0) {
      throw new ExecutionError(
        'OPEN_SELL_ORDER',
        'an existing open Demo sell order must be reconciled first',
        {
          openSellOrderCount: openOrders,
        },
      );
    }
    const createdAt = this.now();
    const intentId = randomId();
    const expiresAt = new Date(createdAt.getTime() + this.config.intentTtlMs).toISOString();
    const confirmationExpiresAt = new Date(
      createdAt.getTime() + this.config.confirmationTtlMs,
    ).toISOString();
    const validation = passedValidation(
      createdAt.toISOString(),
      orderBook,
      balance.availableQuantity,
      openOrders,
    );
    const intent: ExecutionIntent = {
      intentId,
      environment: position.environment,
      positionId: position.positionId,
      providerSymbol: input.providerSymbol,
      side: 'sell',
      orderType: input.orderType,
      requestedQuantity: requestedQuantity.toFixed(),
      limitPrice: limitPrice?.toFixed() ?? null,
      maximumAcceptableSlippageBps: input.maximumAcceptableSlippageBps ?? null,
      simulationId: orderBook.snapshotId,
      bookSnapshotId: orderBook.snapshotId,
      bookSource: orderBook.source,
      simulation,
      createdAt: createdAt.toISOString(),
      expiresAt,
      confirmationExpiresAt,
      status: 'awaiting_confirmation',
      validation,
      clientOid: null,
      orderId: null,
    };
    const confirmationToken = randomBytes(24).toString('base64url');
    await this.store.saveIntent(intent);
    await this.store.saveConfirmation({
      tokenHash: sha256(confirmationToken),
      intentId,
      expiresAt: confirmationExpiresAt,
      usedAt: null,
    });
    await this.audit('intent_created', intentId, null, {
      environment: intent.environment,
      providerSymbol: intent.providerSymbol,
      requestedQuantity: intent.requestedQuantity,
    });
    await this.audit('simulation_produced', intentId, null, {
      snapshotId: intent.bookSnapshotId,
      filledQuantity: simulation.filledQuantity,
      condition: simulation.condition.label,
    });
    await this.audit('validation_passed', intentId, null, {
      bookSnapshotId: validation.bookSnapshotId,
      openSellOrderCount: validation.openSellOrderCount,
    });
    await this.audit('confirmation_issued', intentId, null, {
      expiresAt: confirmationExpiresAt,
    });
    return { intent, confirmationToken };
  }

  async getIntent(intentId: string): Promise<ExecutionIntent> {
    const intent = await this.store.getIntent(intentId);
    if (intent === null)
      throw new ExecutionError('INTENT_NOT_FOUND', 'execution intent was not found');
    return intent;
  }

  async prepareTraderDecision(input: PrepareTraderDecisionInput): Promise<PreparedTraderDecision> {
    const position = await this.store.getPosition(input.positionId);
    if (position === null) throw new ExecutionError('POSITION_NOT_FOUND', 'position was not found');
    if (position.providerSymbol !== input.providerSymbol) {
      throw new ExecutionError('INVALID_SYMBOL', 'position and decision symbols do not match');
    }
    const requestedQuantity =
      input.decision === 'hold' ? position.availableQuantity : input.requestedQuantity;
    const requested = decimal(requestedQuantity, 'requestedQuantity');
    validateDecisionQuantity(input.decision, requested, position.availableQuantity);
    if (input.decision === 'hold') {
      const snapshotId = input.simulationSnapshotId;
      if (snapshotId === undefined) {
        throw new ExecutionError(
          'REFRESH_REQUIRED',
          'a successful simulation snapshot is required to record a hold decision',
        );
      }
      const snapshot = this.snapshots.getOrderBook(snapshotId);
      if (snapshot === null || snapshot.providerSymbol !== input.providerSymbol) {
        throw new ExecutionError(
          'REFRESH_REQUIRED',
          'the simulation snapshot is no longer available',
        );
      }
      const simulation = this.simulate(requested, snapshot);
      return {
        decision: input.decision,
        position,
        intent: null,
        simulation,
        bookSource: snapshot.source,
        orderType: null,
        limitPrice: null,
        maximumAcceptableSlippageBps: null,
        confirmationToken: null,
      };
    }
    const created = await this.createIntent({
      positionId: input.positionId,
      providerSymbol: input.providerSymbol,
      orderType: input.orderType ?? 'market',
      requestedQuantity: input.requestedQuantity,
      ...(input.limitPrice === undefined ? {} : { limitPrice: input.limitPrice }),
      ...(input.maximumAcceptableSlippageBps === undefined
        ? {}
        : { maximumAcceptableSlippageBps: input.maximumAcceptableSlippageBps }),
    });
    return {
      decision: input.decision,
      position,
      intent: created.intent,
      simulation: created.intent.simulation,
      bookSource: created.intent.bookSource,
      orderType: created.intent.orderType,
      limitPrice: created.intent.limitPrice,
      maximumAcceptableSlippageBps: created.intent.maximumAcceptableSlippageBps,
      confirmationToken: created.confirmationToken,
    };
  }

  async saveTraderDecision(input: SaveTraderDecisionInput): Promise<CreatedTraderDecision> {
    const prepared = input.prepared;
    const now = this.now();
    const decisionId = randomId();
    const requestedQuantity = prepared.simulation?.requestedQuantity ?? prepared.position.quantity;
    const requested = decimal(requestedQuantity, 'requestedQuantity');
    validateDecisionQuantity(prepared.decision, requested, prepared.position.availableQuantity);
    const exitPercentage =
      prepared.decision === 'hold'
        ? '0'
        : requested.div(prepared.position.availableQuantity).toFixed();
    const confirmationToken = randomBytes(24).toString('base64url');
    const createdAt = now.toISOString();
    const confirmationExpiresAt = new Date(
      now.getTime() + this.config.confirmationTtlMs,
    ).toISOString();
    const decision: TraderDecision = {
      decisionId,
      decision: prepared.decision,
      positionId: prepared.position.positionId,
      environment: prepared.position.environment,
      providerSymbol: prepared.position.providerSymbol,
      positionQuantity: prepared.position.quantity,
      requestedQuantity,
      exitPercentage,
      currentPrice: input.currentPrice,
      orderType: prepared.orderType,
      limitPrice: prepared.limitPrice,
      maximumAcceptableSlippageBps: prepared.maximumAcceptableSlippageBps,
      intentId: prepared.intent?.intentId ?? null,
      simulation: prepared.simulation,
      bookSnapshotId: prepared.simulation?.snapshotId ?? null,
      bookSource: prepared.bookSource,
      decisionStressTest: input.decisionStressTest,
      decisionStressTestInputHash: input.decisionStressTest?.inputHash ?? null,
      createdAt: createdAt,
      confirmedAt: null,
      status: 'awaiting_confirmation',
      executionStatus: 'awaiting_confirmation',
    };
    await this.store.saveDecision(decision);
    if (prepared.intent === null) {
      await this.store.saveConfirmation({
        tokenHash: sha256(confirmationToken),
        intentId: decisionId,
        expiresAt: confirmationExpiresAt,
        usedAt: null,
      });
    } else {
      if (prepared.confirmationToken !== null) {
        await this.store.consumeConfirmation(sha256(prepared.confirmationToken), createdAt);
      }
      await this.store.saveIntent({
        ...prepared.intent,
        expiresAt: new Date(now.getTime() + this.config.intentTtlMs).toISOString(),
        confirmationExpiresAt,
      });
      await this.store.saveConfirmation({
        tokenHash: sha256(confirmationToken),
        intentId: prepared.intent.intentId,
        expiresAt: confirmationExpiresAt,
        usedAt: null,
      });
      await this.audit('confirmation_issued', prepared.intent.intentId, null, {
        expiresAt: confirmationExpiresAt,
        reason: 'final review payload completed',
      });
    }
    return { decision, confirmationToken };
  }

  async getDecision(decisionId: string): Promise<TraderDecision> {
    const decision = await this.store.getDecision(decisionId);
    if (decision === null)
      throw new ExecutionError('DECISION_NOT_FOUND', 'trader decision was not found');
    return decision;
  }

  async confirmTraderDecision(
    decisionId: string,
    confirmationToken: string,
  ): Promise<TraderDecisionConfirmationResult> {
    const decision = await this.getDecision(decisionId);
    if (decision.status !== 'awaiting_confirmation') {
      throw new ExecutionError('CONFIRMATION_REUSED', 'trader decision has already been confirmed');
    }
    if (decision.intentId === null) {
      await this.confirmationForIntent(decisionId, confirmationToken);
      const confirmed = await this.store.saveDecision({
        ...decision,
        status: 'confirmed',
        confirmedAt: this.now().toISOString(),
        executionStatus: 'not_applicable',
      });
      return { status: 'confirmed', decision: confirmed, intent: null, order: null };
    }
    if (decision.environment === 'SIMULATED') {
      const position = await this.store.getPosition(decision.positionId);
      if (position === null)
        throw new ExecutionError('POSITION_NOT_FOUND', 'position was not found');
      const intent = await this.getIntent(decision.intentId);
      const freshBook = await this.fetchFreshOrderBook(decision.providerSymbol);
      const freshSimulation = this.simulate(
        decimal(decision.requestedQuantity, 'requestedQuantity'),
        freshBook,
      );
      if (
        decision.simulation !== null &&
        paperEstimateChanged(
          decision.simulation,
          freshSimulation,
          this.config.paperRefreshToleranceBps,
        )
      ) {
        await this.confirmationForIntent(decision.intentId, confirmationToken);
        const refreshedIntent = await this.refreshIntent(
          intent,
          freshBook,
          freshSimulation,
          position.availableQuantity,
          0,
        );
        const refreshedDecision = await this.store.saveDecision({
          ...decision,
          simulation: freshSimulation,
          bookSnapshotId: freshBook.snapshotId,
          bookSource: freshBook.source,
          decisionStressTest: null,
          decisionStressTestInputHash: null,
          status: 'awaiting_confirmation',
          executionStatus: 'awaiting_confirmation',
        });
        return {
          status: 'refresh_required',
          decision: refreshedDecision,
          confirmationToken: refreshedIntent.confirmationToken,
          simulation: freshSimulation,
        };
      }
      await this.confirmationForIntent(decision.intentId, confirmationToken);
      const confirmed = await this.store.saveDecision({
        ...decision,
        status: 'confirmed',
        confirmedAt: this.now().toISOString(),
        executionStatus: 'execution_unavailable',
      });
      return { status: 'confirmed', decision: confirmed, intent, order: null };
    }
    const result = await this.confirmIntent(decision.intentId, confirmationToken);
    if (result.status === 'refresh_required') {
      const refreshed = await this.store.saveDecision({
        ...decision,
        simulation: result.simulation,
        bookSnapshotId: result.intent.bookSnapshotId,
        bookSource: result.intent.bookSource,
        decisionStressTest: null,
        decisionStressTestInputHash: null,
        status: 'awaiting_confirmation',
        executionStatus: 'awaiting_confirmation',
      });
      return {
        status: 'refresh_required',
        decision: refreshed,
        confirmationToken: result.confirmationToken,
        simulation: result.simulation,
      };
    }
    const confirmed = await this.store.saveDecision({
      ...decision,
      status: result.status,
      confirmedAt: this.now().toISOString(),
      executionStatus: result.status,
    });
    return {
      status: result.status,
      decision: confirmed,
      intent: result.intent,
      order: result.order,
    };
  }

  private async confirmationForIntent(intentId: string, confirmationToken: string): Promise<void> {
    const confirmation = await this.store.getConfirmation(sha256(confirmationToken));
    if (confirmation === null || confirmation.intentId !== intentId) {
      throw new ExecutionError('CONFIRMATION_INVALID', 'confirmation token is invalid');
    }
    if (confirmation.usedAt !== null) {
      throw new ExecutionError(
        'CONFIRMATION_REUSED',
        'confirmation token has already been consumed',
      );
    }
    if (Date.parse(confirmation.expiresAt) <= this.now().getTime()) {
      throw new ExecutionError('CONFIRMATION_EXPIRED', 'confirmation token has expired');
    }
    if (
      !(await this.store.consumeConfirmation(sha256(confirmationToken), this.now().toISOString()))
    ) {
      throw new ExecutionError(
        'CONFIRMATION_REUSED',
        'confirmation token has already been consumed',
      );
    }
  }

  async confirmIntent(intentId: string, confirmationToken: string): Promise<ConfirmationResult> {
    const intent = await this.getIntent(intentId);
    const now = this.now();
    if (intent.orderId !== null) {
      const existingConfirmation = await this.store.getConfirmation(sha256(confirmationToken));
      if (existingConfirmation === null || existingConfirmation.intentId !== intentId) {
        throw new ExecutionError('CONFIRMATION_INVALID', 'confirmation token is invalid');
      }
      if (existingConfirmation.usedAt !== null) {
        throw new ExecutionError(
          'CONFIRMATION_REUSED',
          'confirmation token has already been consumed',
        );
      }
      if (Date.parse(existingConfirmation.expiresAt) <= now.getTime()) {
        throw new ExecutionError('CONFIRMATION_EXPIRED', 'confirmation token has expired');
      }
      await this.store.consumeConfirmation(sha256(confirmationToken), now.toISOString());
      const order = await this.requireOrder(intent.orderId);
      return { status: resultStatus(order.status), intent, order };
    }
    if (Date.parse(intent.expiresAt) <= now.getTime()) {
      throw new ExecutionError('INTENT_EXPIRED', 'execution intent has expired');
    }
    if (intent.environment !== 'BITGET_DEMO') {
      throw new ExecutionError(
        'MANUAL_POSITION_NOT_EXECUTABLE',
        'manual positions remain simulation-only and cannot submit a Demo order',
      );
    }
    if (!this.demo.credentialsConfigured) {
      throw new ExecutionError('DEMO_UNAVAILABLE', 'BITGET_DEMO credentials are not configured');
    }
    const tokenHash = sha256(confirmationToken);
    const confirmation = await this.store.getConfirmation(tokenHash);
    if (confirmation === null || confirmation.intentId !== intentId) {
      throw new ExecutionError('CONFIRMATION_INVALID', 'confirmation token is invalid');
    }
    if (confirmation.usedAt !== null) {
      throw new ExecutionError(
        'CONFIRMATION_REUSED',
        'confirmation token has already been consumed',
      );
    }
    if (Date.parse(confirmation.expiresAt) <= now.getTime()) {
      throw new ExecutionError('CONFIRMATION_EXPIRED', 'confirmation token has expired');
    }
    const position = await this.store.getPosition(intent.positionId);
    if (position === null) throw new ExecutionError('POSITION_NOT_FOUND', 'position was not found');
    const instrument = await this.requireInstrument(intent.providerSymbol);
    const requestedQuantity = decimal(intent.requestedQuantity, 'requestedQuantity');
    const balance = await this.refreshBalance(position, instrument);
    validateRequestedQuantity(requestedQuantity, balance.availableQuantity);
    validateInstrumentQuantity(requestedQuantity, instrument);
    const freshBook = await this.fetchFreshOrderBook(intent.providerSymbol);
    const freshSimulation = this.simulate(requestedQuantity, freshBook);
    validateSimulation(freshSimulation, intent.maximumAcceptableSlippageBps ?? undefined);
    validateMinimumAmount(
      requestedQuantity,
      instrument,
      intent.limitPrice ?? freshSimulation.bestBid,
    );
    const openOrders = await this.refreshOpenSellOrders(position, intent.providerSymbol);
    if (openOrders > 0) {
      throw new ExecutionError(
        'OPEN_SELL_ORDER',
        'an existing open Demo sell order must be reconciled first',
        {
          openSellOrderCount: openOrders,
        },
      );
    }
    if (materiallyChanged(intent.simulation, freshSimulation)) {
      await this.store.consumeConfirmation(tokenHash, now.toISOString());
      const refreshed = await this.refreshIntent(
        intent,
        freshBook,
        freshSimulation,
        balance.availableQuantity,
        openOrders,
      );
      await this.audit('refresh_required', refreshed.intent.intentId, null, {
        previousSnapshotId: intent.bookSnapshotId,
        currentSnapshotId: freshBook.snapshotId,
      });
      return {
        status: 'refresh_required',
        intent: refreshed.intent,
        simulation: refreshed.intent.simulation,
        confirmationToken: refreshed.confirmationToken,
      };
    }
    const consumed = await this.store.consumeConfirmation(tokenHash, now.toISOString());
    if (!consumed)
      throw new ExecutionError(
        'CONFIRMATION_REUSED',
        'confirmation token has already been consumed',
      );
    await this.audit('confirmation_consumed', intentId, null, { snapshotId: freshBook.snapshotId });
    const clientOid = clientOrderId(intentId);
    const internalOrderId = sha256(canonicalJson({ intentId, clientOid }));
    const existingOrder = await this.store.findOrderByClientOid(clientOid);
    if (existingOrder !== null) {
      const existingIntent = await this.store.getIntent(intentId);
      if (existingIntent === null)
        throw new ExecutionError('INTENT_NOT_FOUND', 'execution intent was not found');
      return {
        status: resultStatus(existingOrder.status),
        intent: existingIntent,
        order: existingOrder,
      };
    }
    const pendingOrder: ExecutionOrder = {
      internalOrderId,
      intentId,
      environment: 'BITGET_DEMO',
      providerSymbol: intent.providerSymbol,
      side: 'sell',
      orderType: intent.orderType,
      requestedQuantity: intent.requestedQuantity,
      limitPrice: intent.limitPrice,
      clientOid,
      providerOrderId: null,
      status: 'pending_verification',
      provider: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastVerifiedAt: null,
    };
    await this.store.saveOrder(pendingOrder);
    const submittingIntent = await this.store.saveIntent({
      ...intent,
      status: 'submitted',
      clientOid,
      orderId: internalOrderId,
      bookSnapshotId: freshBook.snapshotId,
      simulationId: freshBook.snapshotId,
      bookSource: freshBook.source,
      simulation: freshSimulation,
      validation: passedValidation(
        now.toISOString(),
        freshBook,
        balance.availableQuantity,
        openOrders,
      ),
    });
    await this.audit('provider_submission_started', intentId, internalOrderId, {
      clientOid,
      environment: 'BITGET_DEMO',
    });
    let providerOrder: Awaited<ReturnType<BitgetDemoRealityAdapter['placeOrder']>> | null;
    try {
      const orderIntent: DemoOrderIntent = {
        symbol: intent.providerSymbol,
        side: 'sell',
        orderType: intent.orderType,
        quantity: intent.requestedQuantity,
        clientOid,
        ...(intent.limitPrice === null ? {} : { price: intent.limitPrice }),
      };
      providerOrder = await this.demo.placeOrder(orderIntent);
    } catch {
      await this.audit('reconciliation_attempt', intentId, internalOrderId, {
        clientOid,
        reason: 'provider submission threw; querying clientOid before any retry',
      });
      try {
        providerOrder = await this.demo.getOrderByClientOid(clientOid);
      } catch {
        providerOrder = null;
      }
      if (providerOrder === null) {
        const ambiguous = await this.saveOrderState(pendingOrder, 'ambiguous', null);
        const ambiguousIntent = await this.store.saveIntent({
          ...submittingIntent,
          status: 'ambiguous',
        });
        await this.audit('order_state_change', intentId, internalOrderId, {
          status: 'ambiguous',
          reason: 'provider response and clientOid reconciliation were unavailable',
        });
        return { status: 'ambiguous', intent: ambiguousIntent, order: ambiguous };
      }
    }
    const order = await this.saveOrderState(
      pendingOrder,
      mapProviderStatus(providerOrder),
      providerOrder,
    );
    const finalIntent = await this.store.saveIntent({
      ...submittingIntent,
      status: order.status,
    });
    await this.audit('provider_response', intentId, internalOrderId, {
      providerOrderId: order.providerOrderId,
      orderStatus: order.status,
    });
    await this.audit('reconciliation_attempt', intentId, internalOrderId, {
      clientOid,
      orderStatus: order.status,
    });
    await this.audit('order_state_change', intentId, internalOrderId, {
      status: order.status,
      filledQuantity: order.provider?.filledQuantity ?? '0',
    });
    return { status: resultStatus(order.status), intent: finalIntent, order };
  }

  async getOrder(internalOrderId: string): Promise<ExecutionOrderView> {
    const order = await this.store.getOrder(internalOrderId);
    if (order === null)
      throw new ExecutionError('ORDER_NOT_FOUND', 'execution order was not found');
    const intent = await this.store.getIntent(order.intentId);
    if (order.environment !== 'BITGET_DEMO' || isTerminal(order.status)) {
      return { order, intent };
    }
    const updated = await this.reconcileOrder(order);
    return { order: updated, intent: await this.store.getIntent(order.intentId) };
  }

  async cancelOrder(internalOrderId: string): Promise<ExecutionOrderView> {
    const order = await this.store.getOrder(internalOrderId);
    if (order === null)
      throw new ExecutionError('ORDER_NOT_FOUND', 'execution order was not found');
    if (isTerminal(order.status))
      throw new ExecutionError('ORDER_NOT_CANCELABLE', 'order is already terminal');
    const intent = await this.store.getIntent(order.intentId);
    if (intent === null)
      throw new ExecutionError('INTENT_NOT_FOUND', 'execution intent was not found');
    await this.store.saveIntent({ ...intent, status: 'cancel_requested' });
    await this.audit('cancellation_requested', intent.intentId, order.internalOrderId, {
      clientOid: order.clientOid,
    });
    let providerOrder: Awaited<ReturnType<BitgetDemoRealityAdapter['cancelOrder']>>;
    try {
      providerOrder = await this.demo.cancelOrder(order.clientOid);
      const verified = await this.demo.getOrderByClientOid(order.clientOid);
      providerOrder = verified ?? providerOrder;
    } catch {
      providerOrder = null;
    }
    const updated = await this.saveOrderState(
      order,
      providerOrder === null ? 'pending_verification' : mapProviderStatus(providerOrder),
      providerOrder,
    );
    const updatedIntent = await this.store.saveIntent({ ...intent, status: updated.status });
    await this.audit('reconciliation_attempt', intent.intentId, order.internalOrderId, {
      clientOid: order.clientOid,
      orderStatus: updated.status,
    });
    return { order: updated, intent: updatedIntent };
  }

  async listAudit(intentId?: string) {
    return this.store.listAudit(intentId);
  }

  private async refreshIntent(
    intent: ExecutionIntent,
    snapshot: OrderBookSnapshot,
    simulation: ExecutionIntent['simulation'],
    availableQuantity: string,
    openSellOrderCount: number,
  ): Promise<{ intent: ExecutionIntent; confirmationToken: string }> {
    const now = this.now();
    const confirmationExpiresAt = new Date(
      now.getTime() + this.config.confirmationTtlMs,
    ).toISOString();
    const expiresAt = new Date(now.getTime() + this.config.intentTtlMs).toISOString();
    const validation: ExecutionValidation = {
      status: 'refresh_required',
      reasons: [
        {
          metric: 'simulationChanged',
          value: 'true',
          threshold: null,
          detail:
            'fresh confirmation data differs materially from the previously displayed simulation',
        },
      ],
      checkedAt: now.toISOString(),
      bookSnapshotId: snapshot.snapshotId,
      balanceAsOf: now.toISOString(),
      availableQuantity,
      openSellOrderCount,
    };
    const refreshed = await this.store.saveIntent({
      ...intent,
      bookSnapshotId: snapshot.snapshotId,
      simulationId: snapshot.snapshotId,
      bookSource: snapshot.source,
      simulation,
      expiresAt,
      confirmationExpiresAt,
      status: 'awaiting_confirmation',
      validation,
    });
    const confirmationToken = randomBytes(24).toString('base64url');
    await this.store.saveConfirmation({
      tokenHash: sha256(confirmationToken),
      intentId: intent.intentId,
      expiresAt: confirmationExpiresAt,
      usedAt: null,
    });
    return { intent: refreshed, confirmationToken };
  }

  private async reconcileOrder(order: ExecutionOrder): Promise<ExecutionOrder> {
    const intent = await this.store.getIntent(order.intentId);
    await this.audit('reconciliation_attempt', order.intentId, order.internalOrderId, {
      clientOid: order.clientOid,
    });
    let providerOrder: Awaited<ReturnType<BitgetDemoRealityAdapter['getOrderByClientOid']>>;
    try {
      providerOrder = await this.demo.getOrderByClientOid(order.clientOid);
    } catch {
      providerOrder = null;
    }
    if (providerOrder === null) return order;
    const updated = await this.saveOrderState(
      order,
      mapProviderStatus(providerOrder),
      providerOrder,
    );
    if (intent !== null) await this.store.saveIntent({ ...intent, status: updated.status });
    await this.audit('order_state_change', order.intentId, order.internalOrderId, {
      status: updated.status,
      filledQuantity: providerOrder.filledQuantity,
    });
    return updated;
  }

  private async saveOrderState(
    order: ExecutionOrder,
    status: ExecutionOrderStatus,
    provider: ExecutionOrder['provider'],
  ): Promise<ExecutionOrder> {
    const updated: ExecutionOrder = {
      ...order,
      status,
      provider,
      providerOrderId: provider?.orderId ?? order.providerOrderId,
      updatedAt: this.now().toISOString(),
      lastVerifiedAt: provider === null ? order.lastVerifiedAt : this.now().toISOString(),
    };
    return this.store.saveOrder(updated);
  }

  private async requireInstrument(symbol: string): Promise<NormalizedRealityInstrument> {
    const universe = await this.marketData.discoverRealityInstruments();
    const instrument = universe.data.find((item) => item.providerSymbol === symbol);
    if (instrument === undefined)
      throw new ExecutionError(
        'INSTRUMENT_NOT_FOUND',
        `Reality instrument ${symbol} was not found`,
      );
    if (instrument.providerSymbol !== symbol)
      throw new ExecutionError('INVALID_SYMBOL', 'provider symbol mismatch');
    if (instrument.status?.toLowerCase() !== 'online') {
      throw new ExecutionError('INSTRUMENT_OFFLINE', `Reality instrument ${symbol} is not online`);
    }
    return instrument;
  }

  private async refreshBalance(
    position: Position,
    instrument: NormalizedRealityInstrument,
  ): Promise<Position> {
    if (position.source === 'manual') return position;
    if (!this.demo.credentialsConfigured)
      throw new ExecutionError('DEMO_UNAVAILABLE', 'BITGET_DEMO credentials are not configured');
    const assets = await this.demo.getAssets();
    const balance = assets.find((asset) => asset.asset === requireBaseCoin(instrument));
    if (balance === undefined)
      throw new ExecutionError(
        'INSUFFICIENT_POSITION',
        `Demo balance for ${instrument.baseCoin ?? 'base asset'} is unavailable`,
      );
    const freshness = assessFreshness(balance.providerTimestamp, balance.receivedAt, this.now(), {
      ...DEFAULT_FRESHNESS_CONFIG,
      freshMaxAgeMs: this.config.balanceFreshMaxAgeMs,
    });
    if (freshness.state !== 'fresh') {
      throw new ExecutionError(
        'DEMO_UNAVAILABLE',
        `Demo balance is ${freshness.state}: ${freshness.reason}`,
      );
    }
    const available = decimal(balance.available, 'Demo available balance');
    const locked = decimal(balance.locked, 'Demo locked balance');
    const total = decimal(balance.total, 'Demo total balance');
    const quantity = total.gt(0) ? total : available.plus(locked);
    const refreshed: Position = {
      ...position,
      quantity: quantity.toFixed(),
      availableQuantity: available.toFixed(),
      lockedQuantity: locked.toFixed(),
      asOf: balance.receivedAt,
      isSimulated: false,
      environment: 'BITGET_DEMO',
    };
    await this.store.savePosition(refreshed);
    return refreshed;
  }

  private async refreshOpenSellOrders(position: Position, symbol: string): Promise<number> {
    if (position.source === 'manual') return 0;
    const orders = await this.demo.getOpenOrders(symbol);
    return orders.filter(
      (order) => order.side === 'sell' && ['live', 'partially_filled'].includes(order.orderStatus),
    ).length;
  }

  private async fetchFreshOrderBook(symbol: string): Promise<OrderBookSnapshot> {
    let result;
    try {
      result = await this.marketData.getOrderBook(symbol);
    } catch (error) {
      throw new ExecutionError(
        'PROVIDER_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }
    const snapshot = this.snapshots.saveOrderBook(result.data);
    const freshness = snapshotFreshness(snapshot, this.now(), this.qualityConfig);
    if (freshness.state !== 'fresh') {
      throw new ExecutionError(
        'STALE_BOOK',
        `order book is ${freshness.state}: ${freshness.reason}`,
      );
    }
    return snapshot;
  }

  private simulate(quantity: Decimal, snapshot: OrderBookSnapshot) {
    return simulateExit({
      providerSymbol: snapshot.providerSymbol,
      requestedQuantity: quantity.toFixed(),
      snapshot,
      now: this.now(),
      config: this.qualityConfig,
    });
  }

  private async requireOrder(orderId: string): Promise<ExecutionOrder> {
    const order = await this.store.getOrder(orderId);
    if (order === null)
      throw new ExecutionError('ORDER_NOT_FOUND', 'execution order was not found');
    return order;
  }

  private async audit(
    eventType: Parameters<ExecutionStore['appendAudit']>[0]['eventType'],
    intentId: string,
    orderId: string | null,
    details: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.store.appendAudit({
      eventId: randomId(),
      eventType,
      intentId,
      orderId,
      occurredAt: this.now().toISOString(),
      details,
    });
  }
}

function decimal(value: string, field: string): Decimal {
  try {
    const result = new Decimal(value);
    if (!result.isFinite() || result.isNegative())
      throw new Error('must be finite and non-negative');
    return result;
  } catch {
    throw new ExecutionError('INVALID_QUANTITY', `${field} must be a non-negative decimal string`);
  }
}

function decimalOrNull(value: string | null): Decimal | null {
  if (value === null) return null;
  try {
    const result = new Decimal(value);
    return result.isFinite() ? result : null;
  } catch {
    return null;
  }
}

function requireBaseCoin(instrument: NormalizedRealityInstrument): string {
  if (instrument.baseCoin === null || instrument.baseCoin === '') {
    throw new ExecutionError('INSTRUMENT_NOT_FOUND', 'Reality instrument has no base coin mapping');
  }
  return instrument.baseCoin;
}

function validatePositionQuantities(quantity: Decimal, available: Decimal, locked: Decimal): void {
  if (quantity.lte(0))
    throw new ExecutionError('INVALID_QUANTITY', 'position quantity must be greater than zero');
  if (available.lt(0) || locked.lt(0) || !available.plus(locked).equals(quantity)) {
    throw new ExecutionError(
      'INVALID_QUANTITY',
      'position quantities must satisfy available + locked = quantity',
    );
  }
}

function validateRequestedQuantity(quantity: Decimal, availableQuantity: string): void {
  if (quantity.lte(0))
    throw new ExecutionError('INVALID_QUANTITY', 'requested quantity must be greater than zero');
  const available = decimal(availableQuantity, 'availableQuantity');
  if (quantity.gt(available)) {
    throw new ExecutionError(
      'INSUFFICIENT_POSITION',
      'requested quantity exceeds available position quantity',
      {
        requestedQuantity: quantity.toFixed(),
        availableQuantity: available.toFixed(),
      },
    );
  }
}

function validateDecisionQuantity(
  decision: TraderDecisionKind,
  requestedQuantity: Decimal,
  availableQuantity: string,
): void {
  validateRequestedQuantity(requestedQuantity, availableQuantity);
  const available = decimal(availableQuantity, 'availableQuantity');
  if (decision === 'full_exit' && !requestedQuantity.equals(available)) {
    throw new ExecutionError(
      'DECISION_QUANTITY_MISMATCH',
      'full_exit must use the entire available position quantity',
      {
        requestedQuantity: requestedQuantity.toFixed(),
        availableQuantity: available.toFixed(),
      },
    );
  }
  if (decision === 'partial_exit' && !requestedQuantity.lt(available)) {
    throw new ExecutionError(
      'DECISION_QUANTITY_MISMATCH',
      'partial_exit must use a positive quantity smaller than the available position quantity',
      {
        requestedQuantity: requestedQuantity.toFixed(),
        availableQuantity: available.toFixed(),
      },
    );
  }
}

function validateInstrumentQuantity(
  quantity: Decimal,
  instrument: NormalizedRealityInstrument,
): void {
  const precision = parsePrecision(instrument.quantityPrecision);
  if (precision !== null && quantity.decimalPlaces() > precision) {
    throw new ExecutionError(
      'QUANTITY_PRECISION',
      'requested quantity exceeds provider quantity precision',
      {
        quantity: quantity.toFixed(),
        quantityPrecision: precision,
      },
    );
  }
  const minimum = decimalOrNull(instrument.minOrderQty);
  if (minimum !== null && quantity.lt(minimum)) {
    throw new ExecutionError(
      'MINIMUM_QUANTITY',
      'requested quantity is below the provider minimum quantity',
      {
        requestedQuantity: quantity.toFixed(),
        minimumQuantity: minimum.toFixed(),
      },
    );
  }
}

function validatePrice(price: Decimal, instrument: NormalizedRealityInstrument): void {
  const precision = parsePrecision(instrument.pricePrecision);
  if (precision !== null && price.decimalPlaces() > precision) {
    throw new ExecutionError('QUANTITY_PRECISION', 'limit price exceeds provider price precision', {
      limitPrice: price.toFixed(),
      pricePrecision: precision,
    });
  }
}

function validateMinimumAmount(
  quantity: Decimal,
  instrument: NormalizedRealityInstrument,
  referencePrice: string | null,
): void {
  const minimum = decimalOrNull(instrument.minOrderAmount);
  if (minimum === null) return;
  if (referencePrice === null) {
    throw new ExecutionError(
      'MINIMUM_AMOUNT',
      'minimum amount cannot be checked without a valid reference price',
    );
  }
  const notional = quantity.times(decimal(referencePrice, 'reference price'));
  if (notional.lt(minimum)) {
    throw new ExecutionError(
      'MINIMUM_AMOUNT',
      'requested quantity is below the provider minimum amount',
      {
        estimatedNotional: notional.toFixed(),
        minimumAmount: minimum.toFixed(),
      },
    );
  }
}

function validateSimulation(
  simulation: ReturnType<typeof simulateExit>,
  maximumSlippage?: string,
): void {
  if (simulation.condition.label === 'invalid-book') {
    throw new ExecutionError('INVALID_BOOK', 'current order book is invalid', {
      reasonCount: simulation.condition.reasons.length,
    });
  }
  if (simulation.condition.label === 'execution-unavailable' || simulation.bestBid === null) {
    throw new ExecutionError('INVALID_BOOK', 'current order book has no executable bid depth', {
      condition: simulation.condition.label,
      reasonCount: simulation.condition.reasons.length,
    });
  }
  if (simulation.freshness.state !== 'fresh') {
    throw new ExecutionError('STALE_BOOK', `current order book is ${simulation.freshness.state}`);
  }
  if (maximumSlippage !== undefined && simulation.slippageVersusMidpointBps !== null) {
    const maximum = decimal(maximumSlippage, 'maximumAcceptableSlippageBps');
    if (new Decimal(simulation.slippageVersusMidpointBps).gt(maximum)) {
      throw new ExecutionError(
        'MAX_SLIPPAGE_EXCEEDED',
        'simulation exceeds the requested maximum slippage',
        {
          simulatedSlippageBps: simulation.slippageVersusMidpointBps,
          maximumAcceptableSlippageBps: maximum.toFixed(),
        },
      );
    }
  }
}

function passedValidation(
  checkedAt: string,
  snapshot: OrderBookSnapshot,
  availableQuantity: string,
  openSellOrderCount: number,
): ExecutionValidation {
  return {
    status: 'passed',
    reasons: [],
    checkedAt,
    bookSnapshotId: snapshot.snapshotId,
    balanceAsOf: checkedAt,
    availableQuantity,
    openSellOrderCount,
  };
}

function snapshotFreshness(
  snapshot: OrderBookSnapshot,
  now: Date,
  qualityConfig: MarketQualityConfig,
) {
  return assessFreshness(
    snapshot.providerTimestamp,
    snapshot.receivedAt,
    now,
    qualityConfig.freshness,
  );
}

function materiallyChanged(
  previous: ExecutionIntent['simulation'],
  current: ExecutionIntent['simulation'],
): boolean {
  return (
    previous.bestBid !== current.bestBid ||
    previous.midpoint !== current.midpoint ||
    previous.absoluteSpread !== current.absoluteSpread ||
    previous.filledQuantity !== current.filledQuantity ||
    previous.unfilledQuantity !== current.unfilledQuantity ||
    previous.slippageVersusMidpointBps !== current.slippageVersusMidpointBps
  );
}

/**
 * A live book ticks constantly, so exact equality would ask a paper decision to be
 * re-reviewed on every confirmation. Refresh only when the outcome actually differs:
 * the fill, the liquidity condition, or the average price beyond the tolerance.
 */
function paperEstimateChanged(
  previous: ExecutionIntent['simulation'],
  current: ExecutionIntent['simulation'],
  toleranceBps: string,
): boolean {
  if (
    previous.filledQuantity !== current.filledQuantity ||
    previous.unfilledQuantity !== current.unfilledQuantity ||
    previous.condition.label !== current.condition.label
  ) {
    return true;
  }
  const before = decimalOrNull(previous.estimatedVWAP);
  const after = decimalOrNull(current.estimatedVWAP);
  if (before === null || after === null || before.lte(0)) {
    return previous.estimatedVWAP !== current.estimatedVWAP;
  }
  return after.minus(before).abs().div(before).times(10_000).gt(toleranceBps);
}

function parsePrecision(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function randomId(): string {
  return sha256(`${Date.now()}-${randomBytes(16).toString('hex')}`);
}

function clientOrderId(intentId: string): string {
  return `am-${intentId.slice(0, 28)}`;
}

function mapProviderStatus(provider: ExecutionOrder['provider']): ExecutionOrderStatus {
  if (provider === null) return 'ambiguous';
  switch (provider.orderStatus.toLowerCase()) {
    case 'live':
    case 'new':
      return 'live';
    case 'partially_filled':
    case 'partial_fill':
      return 'partially_filled';
    case 'filled':
      return 'filled';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'rejected':
      return 'rejected';
    default:
      return 'pending_verification';
  }
}

function resultStatus(
  status: ExecutionOrderStatus,
): Exclude<ConfirmationResult['status'], 'refresh_required'> {
  if (status === 'submitted') return 'submitted';
  if (status === 'pending_verification') return 'pending_verification';
  if (status === 'live') return 'live';
  if (status === 'partially_filled') return 'partially_filled';
  if (status === 'filled') return 'filled';
  return 'ambiguous';
}

function isTerminal(status: ExecutionOrderStatus): boolean {
  return status === 'filled' || status === 'canceled' || status === 'rejected';
}
