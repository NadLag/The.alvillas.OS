import { externalRefundSupervisionReadInput, externalRefundSupervisionCommandInput, externalRefundSupervisedReceiptSchema, externalRefundSupervisedRecoverySchema } from "../domain/external-payment-refund-supervision-workspace";
import { externalRefundSupervisionRecoveryInput } from "../domain/external-payment-refund-supervision";
import { reviewExternalPaymentRefundSupervision } from "./external-payment-refund-supervision";
import { listExternalRefundsForSupervision } from "./external-payment-refund-supervision-workspace-service";
import { reviewSupervisedExternalPaymentRefundAdmission, admitSupervisedExternalPaymentRefund, recoverSupervisedExternalPaymentRefund } from "./external-payment-refund-supervised-admission";
import { readSupervisedExternalPaymentRefundFee, prepareSupervisedExternalPaymentRefundFee } from "./external-payment-refund-supervised-fee";
import type { FinanceActorContext } from "./finance-access";
import type { TenantTransactionRunner } from "@/platform/db/tenant";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export async function readExternalRefundSupervisionWorkspace(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = externalRefundSupervisionReadInput.parse(raw);
  if (command.operation === "LIST") return listExternalRefundsForSupervision(ctx, command.input, deps);
  if (command.operation === "REVIEW") return reviewExternalPaymentRefundSupervision(ctx, command.input, deps);
  if (command.operation === "GET_FEE") return readSupervisedExternalPaymentRefundFee(ctx, command.input, deps);
  return reviewSupervisedExternalPaymentRefundAdmission(ctx, command.input, deps);
}
export async function executeExternalRefundSupervisionCommand(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = externalRefundSupervisionCommandInput.parse(raw);
  if (command.operation === "PREPARE_FEE") return prepareSupervisedExternalPaymentRefundFee(ctx, command.input, deps);
  const result = await admitSupervisedExternalPaymentRefund(ctx, command.input, deps);
  return externalRefundSupervisedReceiptSchema.parse({ ...result, requestId: command.input.idempotencyKey, idempotencyKey: command.input.idempotencyKey, state: "SUCCEEDED", failureCode: null });
}
export async function recoverExternalRefundSupervisionReceipt(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = externalRefundSupervisionRecoveryInput.parse(raw), result = await recoverSupervisedExternalPaymentRefund(ctx, input, deps);
  return externalRefundSupervisedRecoverySchema.parse({ request: result.request ? { ...result.request, requestId: input.key, idempotencyKey: input.key, state: "SUCCEEDED", failureCode: null } : null });
}
