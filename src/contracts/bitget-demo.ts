import { z } from 'zod';

const StringLike = z.union([z.string(), z.number()]).transform(String);
const NullableStringLike = z
  .union([z.string(), z.number(), z.null()])
  .transform((value) => (value === null ? null : String(value)));

export const DemoResponseBaseSchema = z
  .object({
    code: z.string(),
    msg: z.string(),
    requestTime: StringLike.optional(),
  })
  .passthrough();

export const DemoAssetSchema = z
  .object({
    coin: z.string(),
    available: NullableStringLike.optional(),
    availableBalance: NullableStringLike.optional(),
    frozen: NullableStringLike.optional(),
    locked: NullableStringLike.optional(),
    equity: NullableStringLike.optional(),
    balance: NullableStringLike.optional(),
    total: NullableStringLike.optional(),
  })
  .passthrough();

export const DemoAssetsDataSchema = z.union([
  z.array(DemoAssetSchema),
  z
    .object({
      assets: z.array(DemoAssetSchema),
      accountEquity: NullableStringLike.optional(),
      usdtEquity: NullableStringLike.optional(),
    })
    .passthrough(),
  z
    .object({
      list: z.array(DemoAssetSchema),
      cursor: z.string().nullable().optional(),
    })
    .passthrough(),
]);

export const DemoAccountSettingsSchema = z.record(z.string(), z.unknown());

export const DemoOrderSchema = z
  .object({
    orderId: z.union([z.string(), z.number()]).transform(String).optional(),
    clientOid: z.string().optional(),
    category: z.string().optional(),
    symbol: z.string().optional(),
    orderType: z.string().optional(),
    side: z.string().optional(),
    price: NullableStringLike.optional(),
    qty: NullableStringLike.optional(),
    cumExecQty: NullableStringLike.optional(),
    cumExecValue: NullableStringLike.optional(),
    avgPrice: NullableStringLike.optional(),
    orderStatus: z.string().optional(),
    feeDetail: z.array(z.record(z.string(), z.unknown())).optional(),
    createdTime: NullableStringLike.optional(),
    updatedTime: NullableStringLike.optional(),
  })
  .passthrough();

export const DemoOrderInfoDataSchema = z.union([
  DemoOrderSchema,
  z
    .object({
      list: z.array(DemoOrderSchema),
    })
    .passthrough(),
]);

export const DemoOrderListDataSchema = z
  .object({
    list: z.array(DemoOrderSchema),
    cursor: z.string().nullable().optional(),
  })
  .passthrough();

export const DemoPlaceOrderDataSchema = z.object({
  orderId: z.union([z.string(), z.number()]).transform(String),
  clientOid: z.string(),
});

export type BitgetDemoAsset = z.infer<typeof DemoAssetSchema>;
export type BitgetDemoOrder = z.infer<typeof DemoOrderSchema>;
export type BitgetDemoAccountSettings = z.infer<typeof DemoAccountSettingsSchema>;
