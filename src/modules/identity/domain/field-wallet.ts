import { z } from "zod";

export const walletHistoryPageSchema = z.coerce.number().int().min(1).max(100000).default(1);
export const fieldWalletQuerySchema = z.object({ page: walletHistoryPageSchema }).strict();
const amount = z.string().max(80).regex(/^-?\d+(?:\.\d+)?$/u), currency = z.string().regex(/^[A-Z]{3}$/u);
export const fieldWalletSnapshotSchema = z.object({
  organizationId: z.uuid(), userId: z.uuid(), snapshotAt: z.iso.datetime(), page: walletHistoryPageSchema,
  linked: z.boolean(), baseCurrency: currency,
  balances: z.array(z.object({ amount, currency }).strict()).max(200),
  movements: z.array(z.object({ id: z.uuid(), reference: z.string().max(240), description: z.string().max(1000).nullable(),
    occurredAt: z.iso.datetime(), amount, currency, side: z.enum(["DEBIT", "CREDIT"]), bucket: z.string().max(120).nullable() }).strict()).max(25),
  hasNext: z.boolean(), compensationVisible: z.boolean(),
  compensationTerms: z.array(z.object({ id: z.uuid(), mode: z.string().max(80), amount, currency, effectiveFrom: z.iso.datetime() }).strict()).max(1000),
}).strict();
export type FieldWalletSnapshot = z.infer<typeof fieldWalletSnapshotSchema>;
