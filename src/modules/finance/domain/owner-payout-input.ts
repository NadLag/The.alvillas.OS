import {z} from "zod";
import {financialTransferSchema} from "./financial-transfer-input";
const id=z.uuid().transform(value=>value.toLowerCase());

export const ownerPayoutDraftSchema = z.object({
  propertyId: id,
  ownerId: id,
  reservationId: id.optional(),
  expectedSettlementAt: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()).optional(),
  payoutMethodId: id,
  fundingAccountId: id,
  amount: financialTransferSchema.shape.amount,
  currency: financialTransferSchema.shape.currency,
  purpose: financialTransferSchema.shape.purpose,
  reason: financialTransferSchema.shape.reason,
  idempotencyKey: financialTransferSchema.shape.idempotencyKey
}).strict();

