import { externalPaymentCommandInput, externalPaymentReadInput } from "../domain/external-payment-command";
import { requestExternalPaymentCapture } from "./external-payment-service";
import { getExternalPaymentIntent, resumeExternalPaymentCapture, reviewCapturedPayPalAdmission, reviewExternalPaymentIntent } from "./external-payment-workspace-service";
import { admitCapturedPayPalPayment } from "./native-paypal-admission";
import type { FinanceActorContext } from "./finance-access";
import type { TenantTransactionRunner } from "@/platform/db/tenant";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export async function readExternalPaymentWorkspace(actor: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = externalPaymentReadInput.parse(raw);
  if (command.operation === "REVIEW_CAPTURE") return reviewExternalPaymentIntent(actor, command.input, deps);
  if (command.operation === "REVIEW_ADMISSION") return reviewCapturedPayPalAdmission(actor, command.input, deps);
  return getExternalPaymentIntent(actor, command.input, deps);
}
export async function executeExternalPaymentCommand(actor: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const command = externalPaymentCommandInput.parse(raw);
  if (command.operation === "CAPTURE") return requestExternalPaymentCapture(actor, command.input, deps);
  if (command.operation === "RECONCILE") return resumeExternalPaymentCapture(actor, command.input, deps);
  return admitCapturedPayPalPayment(actor, command.input, deps);
}
