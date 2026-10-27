import { z } from "zod";
import type { Resource } from "@/platform/authz/authorize";
import { calendarDateStart } from "@/platform/time/calendar";
import { ownerPayoutResource } from "@/platform/authz/financial-resource";

export const approvalRequestSchema = z.object({
  propertyId: z.string().uuid(), title: z.string().trim().min(3).max(160),
  details: z.string().trim().min(6).max(2000), idempotencyKey: z.string().uuid()
}).strict();
export const approvalDecisionSchema = z.object({
  id: z.string().uuid(), stageId: z.uuid().optional(), decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().min(6).max(500)
}).strict();
export class ApprovalAccessError extends Error {}
export class ApprovalConflictError extends Error {}
type ApprovalSource = { id: string; organizationId: string; propertyId: string; state: string;
  property: { regionId: string | null; cityId: string | null; timezone?: string }; expenseId?: string | null; payoutId?:string|null;
  payout?:Parameters<typeof ownerPayoutResource>[1]|null;
  expense?: { id: string; state: string; amount: { toString(): string }; reservationId: string | null; occurredOn: Date; createdBy: string } | null };
export function approvalResource(row: ApprovalSource, ownerId?: string | null): Resource {
  if(row.payoutId){
    if(!row.payout)throw new ApprovalAccessError();
    return {...ownerPayoutResource(row.organizationId,row.payout,row.property),approvalId:row.id};
  }
  if (row.expenseId) {
    if (!row.expense || !row.property.timezone) throw new ApprovalAccessError();
    return { type: "expense", id: row.expense.id, financialRecordId: row.expense.id, approvalId: row.id, organizationId: row.organizationId,
      propertyId: row.propertyId, ownerId, reservationId: row.expense.reservationId, amount: row.expense.amount.toString(),
      occurredAt: calendarDateStart(row.expense.occurredOn.toISOString().slice(0,10), row.property.timezone),
      assignedUserAccountId: row.expense.createdBy, dataClass: "financial", region: row.property.regionId, city: row.property.cityId, status: row.expense.state };
  }
  return { type: "property", id: row.id, approvalId: row.id, organizationId: row.organizationId, propertyId: row.propertyId,
    region: row.property.regionId, city: row.property.cityId, status: row.state };
}
