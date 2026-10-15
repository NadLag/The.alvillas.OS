import { z } from "zod";
import type { Resource } from "@/platform/authz/authorize";

export const approvalRequestSchema = z.object({
  propertyId: z.string().uuid(), title: z.string().trim().min(3).max(160),
  details: z.string().trim().min(6).max(2000), idempotencyKey: z.string().uuid()
}).strict();
export const approvalDecisionSchema = z.object({
  id: z.string().uuid(), decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().min(6).max(500)
}).strict();
export class ApprovalAccessError extends Error {}
export class ApprovalConflictError extends Error {}
export function approvalResource(row: { id: string; organizationId: string; propertyId: string; state: string; property: { regionId: string | null; cityId: string | null } }): Resource {
  return { type: "property", id: row.id, organizationId: row.organizationId, propertyId: row.propertyId,
    region: row.property.regionId, city: row.property.cityId, status: row.state };
}
