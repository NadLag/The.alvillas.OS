"use server";

import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { financeActorContextFromSession } from "./finance-access";
import { saveSupplierPriceList } from "./supplier-price-list";
import { SupplierAccessError, SupplierConflictError } from "./supplier-service";

export async function saveSupplierPriceListAction(input: unknown) {
  const actor = await financeActorContextFromSession(await auth());
  if (!actor) return "forbidden";
  try { await saveSupplierPriceList(actor, input); return "saved"; }
  catch (error) {
    if (error instanceof z.ZodError) return "invalid";
    if (error instanceof SupplierAccessError) return "forbidden";
    if (error instanceof SupplierConflictError) return "conflict";
    throw error;
  }
}
