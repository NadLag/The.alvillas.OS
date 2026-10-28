import "server-only";
import { notFound } from "next/navigation";
import { supplierActor } from "./supplier-access";
import { assertSupplierInvoiceAccess, SupplierInvoiceAccessError } from "../application/supplier-invoice-service";
export async function requireSupplierInvoiceAccess(locale: string, action: "view" | "create" | "edit" = "view") {
  const actor = await supplierActor(locale);
  try { await assertSupplierInvoiceAccess(actor, action); } catch (error) { if (error instanceof SupplierInvoiceAccessError) notFound(); throw error; }
  return actor;
}
