import { z } from "zod";
import { authorizeCollection, type AuthContext } from "@/platform/authz/authorize";
import { prisma } from "@/platform/db/client";
import type { TenantTransactionRunner } from "@/platform/db/tenant";
import { pendingApprovalQueue } from "@/platform/approvals/approval-service";
import { authorizeVarianceSource } from "@/platform/reconciliation/variance-source-authority";
import { readVarianceCenter } from "@/modules/finance/application/variance-center-service";
import { VarianceCenterAccessError, VarianceCenterCursorError, varianceCenterProviderSchema } from "@/modules/finance/domain/variance-center";
import { inventoryLocationPage } from "@/modules/inventory/application/location-service";
import { assertInventoryReorderViewer, inventoryReorderPage } from "@/modules/inventory/application/reorder-service";
import { InventoryCatalogAccessError, InventoryCatalogConflictError } from "@/modules/inventory/domain/catalog-errors";
import { maintenanceExceptionPage } from "@/modules/maintenance/application/issue-read-service";
import { reservationCommandExceptionPage } from "@/modules/reservations/application/reservation-management-service";
import { ReservationAuthorizationError } from "@/modules/reservations/application/reservation-service";
import type { ReservationActorContext } from "@/modules/reservations/application/reservation-access";

export const exceptionKinds = ["approvals", "variances", "stock", "maintenance", "conflicts", "sync"] as const;
export const exceptionFilter = z.object({
  kind: z.enum(exceptionKinds).optional(),
  provider: varianceCenterProviderSchema.optional(),
  after: z.string().max(8192).optional(),
  location: z.uuid().optional(),
  locationQuery: z.string().trim().max(100).optional(),
  locationAfter: z.uuid().optional()
});
type Filters = z.infer<typeof exceptionFilter>;
const requirements = {
  approvals: ["approval"], maintenance: ["issue", "task", "property"], stock: ["inventory_movement", "inventory_location", "config_rule"],
  variances: ["financial_transaction"], conflicts: ["reservation"], sync: ["reservation"]
} as const;
export function exceptionSections(context: AuthContext) {
  const has = (resource: string) => authorizeCollection(context, "view", resource);
  const sections = exceptionKinds.filter(kind => requirements[kind].every(has) || kind === "approvals" && ["expense", "supplier_invoice", "property"].some(has));
  return sections;
}
const denied = { state: "denied" } as const, changed = { state: "changed" } as const;
export async function commandExceptionsPage(actor: ReservationActorContext, filter: Filters, db: TenantTransactionRunner = prisma) {
  const sections = exceptionSections(actor.authContext);
  const kind = filter.kind ?? sections[0];
  if (!kind || !sections.includes(kind) || actor.actorId !== actor.authContext.userAccountId) return denied;
  try {
    const uuidCursor = z.uuid().safeParse(filter.after);
    if (kind === "approvals") return { state: "ready", kind, ...await pendingApprovalQueue({
      organizationId: actor.organizationId, accountId: actor.actorId, authContext: actor.authContext
    }, uuidCursor.data, { db }) } as const;
    if (kind === "maintenance") return { state: "ready", kind, ...await maintenanceExceptionPage(actor, uuidCursor.data, { db }) } as const;
    if (kind === "conflicts" || kind === "sync") return { state: "ready", kind, ...await reservationCommandExceptionPage(actor, kind, uuidCursor.data, { db }) } as const;
    if (kind === "variances") {
      const provider = filter.provider && filter.provider !== "INVENTORY" ? filter.provider : "OTA";
      const page = await readVarianceCenter(actor, { provider, status: "OPEN", cursor: filter.after }, { db, authorizeSource: authorizeVarianceSource });
      return { state: "ready", kind, provider, ...page } as const;
    }
    await assertInventoryReorderViewer(actor, { db });
    const locations = await inventoryLocationPage(actor, { query: filter.locationQuery, after: filter.locationAfter }, { db });
    if (!filter.location) return { state: "ready", kind, locations, stock: null, items: [], next: null } as const;
    const stock = await inventoryReorderPage(actor, { mode: "LOCATION", locationId: filter.location, after: filter.after }, { db });
    return { state: "ready", kind, locations, stock, items: stock.items.filter(row => row.minimum?.belowMinimum), next: stock.next } as const;
  } catch (error) {
    if (error instanceof VarianceCenterAccessError || error instanceof InventoryCatalogAccessError || error instanceof ReservationAuthorizationError) return denied;
    if (error instanceof VarianceCenterCursorError || error instanceof InventoryCatalogConflictError || error instanceof z.ZodError) return changed;
    throw error;
  }
}
