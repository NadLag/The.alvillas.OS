"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { createSupplierInvoice, updateSupplierInvoice, setSupplierInvoiceArchived, getSupplierInvoiceChoices, SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-service";

async function run<T>(work: (actor: NonNullable<Awaited<ReturnType<typeof financeActorContextFromSession>>>, requestId: string) => Promise<T>, mutate = true) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new SupplierInvoiceAccessError();
    const data = await work(actor, requestId);
    if (mutate) revalidatePath("/[locale]/app/finance/supplier-invoices", "layout");
    return { ok: true as const, data };
  } catch (error) {
    const code: "forbidden" | "conflict" | "validation" | "error" = error instanceof SupplierInvoiceAccessError ? "forbidden" : error instanceof SupplierInvoiceConflictError ? "conflict" : error instanceof z.ZodError ? "validation" : "error";
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "supplier-invoice-authoring" } });
    return { ok: false as const, code };
  }
}
export async function createSupplierInvoiceAction(input: unknown) { return run((actor, requestId) => createSupplierInvoice(actor, input, { requestId })); }
export async function updateSupplierInvoiceAction(input: unknown) { return run((actor, requestId) => updateSupplierInvoice(actor, input, { requestId })); }
export async function setSupplierInvoiceArchivedAction(input: unknown) { return run((actor, requestId) => setSupplierInvoiceArchived(actor, input, { requestId })); }
export async function getSupplierInvoiceChoicesAction(input: unknown) { return run(actor => getSupplierInvoiceChoices(actor, input), false); }
