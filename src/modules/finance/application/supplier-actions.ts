"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { createSupplier, updateSupplier, setSupplierArchived, SupplierAccessError, SupplierConflictError } from "./supplier-service";

async function run<T>(work: (actor: NonNullable<Awaited<ReturnType<typeof financeActorContextFromSession>>>, requestId: string) => Promise<T>) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new SupplierAccessError();
    const data = await work(actor, requestId); revalidatePath("/[locale]/app/finance/suppliers", "layout"); return { ok: true as const, data };
  } catch (error) {
    const code: "forbidden" | "conflict" | "validation" | "error" = error instanceof SupplierAccessError ? "forbidden" : error instanceof SupplierConflictError ? "conflict" : error instanceof z.ZodError ? "validation" : "error";
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "supplier-source" } });
    return { ok: false as const, code };
  }
}
export async function createSupplierAction(input: unknown) { return run((actor, requestId) => createSupplier(actor, input, { requestId })); }
export async function updateSupplierAction(input: unknown) { return run((actor, requestId) => updateSupplier(actor, input, { requestId })); }
export async function setSupplierArchivedAction(input: unknown) { return run((actor, requestId) => setSupplierArchived(actor, input, { requestId })); }
