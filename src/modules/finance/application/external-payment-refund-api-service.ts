import { externalRefundCommandInput, externalRefundReadInput } from "../domain/external-payment-refund-command";
import { requestExternalPaymentRefund } from "./external-payment-refund-service";
import { getExternalPaymentRefund, reviewExternalPaymentRefund, reconcileExternalPaymentRefund } from "./external-payment-refund-workspace-service";
import { admitExternalPaymentRefund, reviewExternalPaymentRefundAdmission } from "./external-payment-refund-admission";
import type { FinanceActorContext } from "./finance-access";
import type { TenantTransactionRunner } from "@/platform/db/tenant";
type Deps = { db?: TenantTransactionRunner; requestId?: string };
export async function readExternalPaymentRefundWorkspace(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = externalRefundReadInput.parse(raw);
  if (command.operation === "REVIEW") return reviewExternalPaymentRefund(ctx, command.input, deps);
  if (command.operation === "REVIEW_ADMISSION") return reviewExternalPaymentRefundAdmission(ctx, command.input, deps);
  return getExternalPaymentRefund(ctx, command.input, deps);
}
export async function executeExternalPaymentRefundCommand(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = externalRefundCommandInput.parse(raw);
  if (command.operation === "REQUEST") return requestExternalPaymentRefund(ctx, command.input, deps);
  if (command.operation === "RECONCILE") return reconcileExternalPaymentRefund(ctx, command.input, deps);
  return admitExternalPaymentRefund(ctx, command.input, deps);
}
