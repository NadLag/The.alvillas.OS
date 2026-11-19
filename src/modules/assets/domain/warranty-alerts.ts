import { z } from "zod";
import { authorize, type AuthContext, type Resource } from "@/platform/authz/authorize";

export const assetWarrantyPolicyKey = "ops.asset_warranty_alerts";
export const assetWarrantyPolicySchema = z.object({
  lead_days: z.array(z.number().int().min(0).max(3660)).min(1).max(12)
    .refine(days => new Set(days).size === days.length)
}).strict();

export function canReadAssetWarrantyAlert(context: AuthContext, target: Resource, now?: Date) {
  return target.type === "asset" && !!target.propertyId && authorize(context, "view", target, now) &&
    authorize(context, "view", { ...target, type: "property", id: target.propertyId }, now);
}
