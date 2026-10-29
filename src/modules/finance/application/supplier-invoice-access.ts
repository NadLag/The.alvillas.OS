import type { Action } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { FinanceActorContext } from "./finance-access";

export class SupplierInvoiceAccessError extends Error {}
export class SupplierInvoiceConflictError extends Error {}
export const supplierInvoiceOrganizationResource = (organizationId: string) => ({ type: "supplier_invoice", organizationId, dataClass: "financial" as const });
export async function assertSupplierInvoiceAuthority(ctx: FinanceActorContext, tx: TenantTransaction, action: Action, now: Date) {
  if (ctx.actorId !== ctx.authContext.userAccountId || ctx.organizationId !== ctx.authContext.organizationId) throw new SupplierInvoiceAccessError();
  const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
  if (![ctx.authContext, current].every(auth => ["view" as const, action].every(verb => authorizeOrganizationSource(auth, verb, supplierInvoiceOrganizationResource(ctx.organizationId), now)) &&
    authorizeOrganizationSource(auth, "view", { type: "supplier", organizationId: ctx.organizationId, dataClass: "personal" }, now))) throw new SupplierInvoiceAccessError();
  return current;
}
