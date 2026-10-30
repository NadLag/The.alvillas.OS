import { z } from "zod";
import type { Resource } from "@/platform/authz/authorize";
import { calendarDateStart } from "@/platform/time/calendar";

export const approvalRequestSchema = z.object({
  propertyId: z.string().uuid(), title: z.string().trim().min(3).max(160),
  details: z.string().trim().min(6).max(2000), idempotencyKey: z.string().uuid()
}).strict();
export const approvalDecisionSchema = z.object({
  id: z.string().uuid(), stageId: z.uuid().optional(), decision: z.enum(["APPROVED", "REJECTED"]), reason: z.string().trim().min(6).max(500)
}).strict();
export class ApprovalAccessError extends Error {}
export class ApprovalConflictError extends Error {}
export const invoiceApprovalSourceSnapshotSchema = z.object({ lineId: z.uuid(), note: z.string().trim().min(6).max(1000), category: z.string(),
  occurredOn: z.iso.date(), timezone: z.string().min(1), createdBy: z.uuid() }).strict();
export type InvoiceApprovalStageSource = { invoiceLineId: string | null; propertyId: string | null; reservationId: string | null; ownerId: string | null;
  amount: { toString(): string }; currency: string; sourceSnapshot: unknown; property?: { cityId: string | null; regionId: string | null } | null;
  employeeCostId?:string|null;employeeCost?:{id:string;submissionId:string;propertyId:string;reservationId:string|null;category:string;note:string;timezone:string;currency:string}|null };
type ApprovalSource = { id: string; organizationId: string; propertyId: string | null; state: string;
  property: { regionId: string | null; cityId: string | null; timezone?: string } | null; expenseId?: string | null;
  invoiceSubmissionId?: string | null; invoiceSubmission?: { id: string; invoice: { id: string; state: string; currentSubmissionId: string | null } } | null;
  employeeSubmissionId?:string|null;employeeSubmission?:{id:string;submittedBy:string;costOn:Date;withdrawal:{id:string}|null}|null;
  expense?: { id: string; state: string; amount: { toString(): string }; reservationId: string | null; occurredOn: Date; createdBy: string } | null };
export function approvalResource(row: ApprovalSource, ownerId?: string | null, stage?: InvoiceApprovalStageSource): Resource {
  if(row.employeeSubmissionId){
    const source=stage&&invoiceApprovalSourceSnapshotSchema.safeParse(stage.sourceSnapshot),cost=stage?.employeeCost,submission=row.employeeSubmission;
    if(!submission||!stage?.employeeCostId||!cost||cost.id!==stage.employeeCostId||cost.submissionId!==submission.id||!source?.success||source.data.lineId!==cost.id||
      source.data.note!==cost.note||source.data.category!==cost.category||source.data.timezone!==cost.timezone||source.data.createdBy!==submission.submittedBy||
      source.data.occurredOn!==submission.costOn.toISOString().slice(0,10)||stage.propertyId!==cost.propertyId||stage.reservationId!==cost.reservationId||stage.currency!==cost.currency)throw new ApprovalAccessError();
    return{type:"expense",id:cost.id,financialRecordId:cost.id,approvalId:row.id,organizationId:row.organizationId,propertyId:cost.propertyId,reservationId:cost.reservationId,
      ownerId:stage.ownerId,amount:stage.amount.toString(),occurredAt:calendarDateStart(source.data.occurredOn,cost.timezone),assignedUserAccountId:submission.submittedBy,
      dataClass:"financial",city:stage.property?.cityId,region:stage.property?.regionId,status:submission.withdrawal?"CANCELLED":row.state==="PENDING"?"PENDING_APPROVAL":row.state};
  }
  if (row.invoiceSubmissionId) {
    const source = stage && invoiceApprovalSourceSnapshotSchema.safeParse(stage.sourceSnapshot);
    if (!row.invoiceSubmission || !stage?.invoiceLineId || !source || !source.success || source.data.lineId !== stage.invoiceLineId) throw new ApprovalAccessError();
    return { type: "supplier_invoice", organizationId: row.organizationId, id: row.invoiceSubmission.invoice.id, financialRecordId: row.invoiceSubmission.invoice.id,
      approvalId: row.id, propertyId: stage.propertyId, reservationId: stage.reservationId, ownerId: stage.ownerId,
      amount: stage.amount.toString(), occurredAt: calendarDateStart(source.data.occurredOn, source.data.timezone), assignedUserAccountId: source.data.createdBy,
      dataClass: "financial", city: stage.property?.cityId, region: stage.property?.regionId,
      status: row.invoiceSubmission.invoice.currentSubmissionId === row.invoiceSubmissionId ? row.invoiceSubmission.invoice.state : row.state };
  }
  if (row.expenseId) {
    if (!row.expense || !row.property?.timezone || !row.propertyId) throw new ApprovalAccessError();
    return { type: "expense", id: row.expense.id, financialRecordId: row.expense.id, approvalId: row.id, organizationId: row.organizationId,
      propertyId: row.propertyId, ownerId, reservationId: row.expense.reservationId, amount: row.expense.amount.toString(),
      occurredAt: calendarDateStart(row.expense.occurredOn.toISOString().slice(0,10), row.property.timezone),
      assignedUserAccountId: row.expense.createdBy, dataClass: "financial", region: row.property.regionId, city: row.property.cityId, status: row.expense.state };
  }
  if (!row.property || !row.propertyId) throw new ApprovalAccessError();
  return { type: "property", id: row.id, approvalId: row.id, organizationId: row.organizationId, propertyId: row.propertyId,
    region: row.property.regionId, city: row.property.cityId, status: row.state };
}
