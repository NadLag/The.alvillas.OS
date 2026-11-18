import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";
import { authorizeOrganizationSource } from "@/platform/authz/organization-authority";

export type SupplierAlertKind = "supplier_prices_changed" | "supplier_performance_alert";
export function canReadSupplierAlert(ctx: AuthContext, kind: SupplierAlertKind, target: Resource, now = new Date()) {
  if (target.type !== "supplier" || !authorizeOrganizationSource(ctx, "view", target, now)) return false;
  if (kind === "supplier_prices_changed") return authorizeOrganizationSource(ctx, "view", {
    organizationId: target.organizationId, type: "supplier_invoice", dataClass: "financial"
  }, now);
  const resource = { ...target, dataClass: "operational" as const };
  return Boolean(target.propertyId && target.taskId &&
    authorize(ctx, "view", { ...resource, type: "property", id: target.propertyId }, now) &&
    authorize(ctx, "view", { ...resource, type: "task", id: target.taskId }, now));
}

export function supplierAlertResource(organizationId: string, row: {
  supplierId: string; taskId?: string; propertyId?: string; city?: string | null; region?: string | null; status?: string
}): Resource {
  const { supplierId, ...scope } = row;
  return { organizationId, type: "supplier", id: supplierId, dataClass: "personal",
    taskId: scope.taskId, propertyId: scope.propertyId, region: scope.region, city: scope.city, status: scope.status };
}
