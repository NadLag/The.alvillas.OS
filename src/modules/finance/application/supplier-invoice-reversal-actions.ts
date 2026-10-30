"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import { supplierInvoiceReversalInput } from "../domain/supplier-payment";
import { requestSupplierInvoiceReversal } from "./supplier-invoice-recognition-requests";
import { getSupplierInvoiceReversalStatus } from "./supplier-invoice-reversal-status";

const confirmedRequest = z.object({ input: supplierInvoiceReversalInput, confirmed: z.literal(true) }).strict();
async function run<T>(work: (actor: NonNullable<Awaited<ReturnType<typeof financeActorContextFromSession>>>, requestId: string) => Promise<T>, mutate: boolean) {
  const requestId = crypto.randomUUID(); let committed = false;
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new SupplierInvoiceAccessError();
    const data = await work(actor, requestId); committed = mutate;
    if (mutate) revalidatePath("/[locale]/app/finance/supplier-invoices", "layout");
    return { ok: true as const, data };
  } catch (error) {
    const code = committed ? "error" as const : error instanceof SupplierInvoiceAccessError ? "forbidden" as const : error instanceof SupplierInvoiceConflictError ? "conflict" as const :
      error instanceof AccountingPeriodClosedError ? "closed" as const : error instanceof ExpensePolicyUnavailableError ? "policy" as const :
      error instanceof z.ZodError ? "validation" as const : "error" as const;
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "supplier-claim-reversal" } });
    return { ok: false as const, code };
  }
}
export async function getSupplierInvoiceReversalStatusAction(input: unknown) { return run(actor => getSupplierInvoiceReversalStatus(actor, input), false); }
export async function requestSupplierInvoiceReversalAction(raw: unknown) {
  return run((actor, requestId) => {
    const request = confirmedRequest.parse(raw);
    return requestSupplierInvoiceReversal(actor, request.input, { requestId });
  }, true);
}
