"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { AccountingPeriodClosedError, AccountingPeriodPolicyError } from "../domain/accounting-period";
import { supplierPaymentFormInput, supplierPaymentInput } from "../domain/supplier-payment";
import { getSupplierSettlement, postSupplierPayment, voidSupplierPayment } from "./supplier-payment-service";

async function run<T>(work: (actor: NonNullable<Awaited<ReturnType<typeof financeActorContextFromSession>>>, requestId: string) => Promise<T>, mutate = true) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new SupplierInvoiceAccessError();
    const data = await work(actor, requestId);
    if (mutate) revalidatePath("/[locale]/app/finance/supplier-invoices", "layout");
    return { ok: true as const, data };
  } catch (error) {
    const code = error instanceof SupplierInvoiceAccessError ? "forbidden" as const : error instanceof SupplierInvoiceConflictError ? "conflict" as const :
      error instanceof AccountingPeriodClosedError ? "closed" as const : error instanceof ExpensePolicyUnavailableError || error instanceof AccountingPeriodPolicyError ? "policy" as const :
      error instanceof z.ZodError ? "validation" as const : error instanceof RangeError ? "clock" as const : "error" as const;
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "supplier-payment" } });
    return { ok: false as const, code };
  }
}
export async function getSupplierSettlementAction(input: unknown) { return run(actor => getSupplierSettlement(actor, input), false); }
export async function postSupplierPaymentAction(raw: unknown) {
  return run((actor, requestId) => {
    const form = supplierPaymentFormInput.parse(raw), { paidLocal, occurrence, calendarRuleId, calendarRuleVersion, ...input } = form;
    return postSupplierPayment(actor, supplierPaymentInput.parse(input), { requestId,
      calendar: { id: calendarRuleId, version: calendarRuleVersion, local: paidLocal, occurrence } });
  });
}
export async function voidSupplierPaymentAction(input: unknown) { return run((actor, requestId) => voidSupplierPayment(actor, input, { requestId })); }
