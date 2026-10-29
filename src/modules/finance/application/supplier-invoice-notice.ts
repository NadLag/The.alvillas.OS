import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { present } from "@/platform/authz/present";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";
import { SupplierInvoiceAccessError } from "./supplier-invoice-access";

/** An owner reads the retained receipt and their own frozen line allocation only. */
export async function getSupplierInvoiceNotice(ctx: FinanceActorContext, id: string, deps: { db?: TenantTransactionRunner } = {}) {
  id = z.uuid().parse(id);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const notifications = new NotificationRepository(tx, ctx.organizationId);
    if (!await notifications.activeRecipient(ctx.actorId)) throw new SupplierInvoiceAccessError();
    const source = await notifications.invoiceEmergencyNotice(id, ctx.actorId);
    if (!source) throw new SupplierInvoiceAccessError();
    const now = await new FinanceRepository(tx, ctx.organizationId).clock();
    await recheckFinanceAuthorization(ctx, tx, now, [{ action: "view", resource: source.target }], new SupplierInvoiceAccessError());
    return present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...source.target, data: source.data }, {}, now) as typeof source.data;
  }, { isolationLevel: "RepeatableRead" });
}
