import "server-only";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "../application/finance-access";
import { assertSupplierAccess, SupplierAccessError } from "../application/supplier-service";
export async function supplierActor(locale: string) {
  const actor = await financeActorContextFromSession(await auth()); if (!actor) redirect(`/${locale}/login`); return actor;
}
export async function requireSupplierAccess(locale: string, action: "view" | "create" | "edit" = "view") {
  const actor = await supplierActor(locale);
  try { await assertSupplierAccess(actor, action); } catch (error) { if (error instanceof SupplierAccessError) notFound(); throw error; }
}
