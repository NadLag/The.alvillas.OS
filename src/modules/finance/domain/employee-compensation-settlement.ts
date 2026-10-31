import { z } from "zod";
const id=z.uuid().transform(value=>value.toLowerCase()),reason=z.string().trim().min(6).max(500);
export const employeeCompensationSettlementInput=z.object({id,claimId:id,kind:z.enum(["PAYMENT","WALLET_OFFSET"]),fundingAccountId:id,idempotencyKey:id,
  amount:z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u).refine(value=>/[1-9]/u.test(value)),currency:z.string().regex(/^[A-Z]{3}$/u),
  paidAt:z.iso.datetime({offset:true}).transform(value=>new Date(value).toISOString()),reference:z.string().trim().max(160).nullish().transform(value=>value||null),currentPeriod:z.boolean().default(false),reason}).strict();
export const employeeCompensationSettlementVoidInput=z.object({id,claimId:id,paymentId:id,reason}).strict();
export const employeeCompensationSettlementRecoveryInput=z.object({id,claimId:id,key:id}).strict();
export const employeeCompensationSettlementReceiptSchema=z.object({id:z.uuid(),claimId:z.uuid(),paymentId:z.uuid(),kind:employeeCompensationSettlementInput.shape.kind,idempotent:z.boolean()}).strict();
export const employeeCompensationSettlementVoidReceiptSchema=z.object({id:z.uuid(),claimId:z.uuid(),paymentId:z.uuid(),reversalTransactionId:z.uuid(),idempotent:z.boolean()}).strict();
export const employeeCompensationSettlementFormInput=employeeCompensationSettlementInput.extend({paidLocal:z.string().trim().min(1).max(32),occurrence:z.enum(["reject","earlier","later"]).default("reject"),calendarRuleId:id,calendarRuleVersion:z.number().int().positive()}).strict();
export const employeeCompensationSettlementAuditSchema=z.object({input:employeeCompensationSettlementInput,recognitionId:z.uuid(),transactionId:z.uuid(),sourcePeriodId:z.uuid().nullable(),sourcePeriodEventId:z.uuid().nullable(),postedAt:z.iso.datetime()}).strict();
