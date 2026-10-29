import { z } from "zod";
import type { OutboxEvent } from "@prisma/client";
import type { Resource } from "@/platform/authz/authorize";
import { Money } from "@/platform/money/money";
import { supplierInvoiceCostResource } from "@/modules/finance/domain/supplier-invoice";
import type { SupplierInvoiceRepository } from "@/modules/finance/infrastructure/supplier-invoice-repository";

export type InvoiceAutomationSource = { id: string; submissionId: string; revisionId: string; approvalId: string | null;
  authority: Array<{ resource: Resource; organizationOnly: boolean }> };
type Submission = NonNullable<Awaited<ReturnType<SupplierInvoiceRepository["submission"]>>>;
const snapshotSchema = z.object({ invoiceId: z.uuid(), revisionId: z.uuid(), occurredOn: z.iso.date(), stages: z.array(z.unknown()),
  lines: z.array(z.object({ id: z.uuid(), policy: z.object({ timezone: z.string().min(1) }) })) });

/** Frozen source facts are separate from the current permissions protecting them. */
export function invoiceAutomationSource(event: OutboxEvent, source: Submission) {
  const snapshot = snapshotSchema.parse(source.snapshot), day = source.occurredOn.toISOString().slice(0,10);
  if (source.organizationId !== event.organizationId || snapshot.invoiceId !== source.invoiceId || snapshot.revisionId !== source.revisionId ||
    snapshot.occurredOn !== day || source.revision.invoiceId !== source.invoiceId || snapshot.lines.length !== source.revision.lines.length)
    throw Error("automation_source_missing");
  const historicalState = source.approval?.state === "PENDING" ? "PENDING_APPROVAL" : source.approval?.state ?? "APPROVED";
  const currentState = source.invoice.currentSubmissionId === source.id ? source.invoice.state : historicalState;
  const total = Money.of(source.revision.amount.toString(), source.revision.currency);
  const authority: InvoiceAutomationSource["authority"] = [{ organizationOnly: true, resource: { type: "supplier", organizationId: event.organizationId,
    id: source.invoice.supplierId, dataClass: "personal", occurredAt: source.invoice.supplier.createdAt } }];
  for (const line of source.revision.lines) {
    const frozen = snapshot.lines.find(value => value.id === line.id); if (!frozen) throw Error("automation_source_missing");
    const target = supplierInvoiceCostResource(event.organizationId, { ...source.invoice, state: currentState }, line, Money.of(line.amount.toString(), line.currency), day, frozen.policy.timezone);
    authority.push({ organizationOnly: true, resource: { ...target, amount: total.toJSON().amount } });
    authority.push({ organizationOnly: !line.propertyId, resource: { ...target, type: "financial_transaction", id: undefined, financialRecordId: undefined } });
    if (line.reservationId) authority.push({ organizationOnly: false, resource: { ...target, type: "reservation", id: line.reservationId, financialRecordId: undefined,
      status: line.reservation?.status, assignedUserAccountId: line.reservation?.createdBy ?? undefined } });
  }
  const submittedState = snapshot.stages.length ? "PENDING_APPROVAL" : "APPROVED";
  const invoice: InvoiceAutomationSource = { id: source.invoiceId, submissionId: source.id, revisionId: source.revisionId, approvalId: source.approval?.id ?? null, authority };
  const fields = { organization: { id: event.organizationId }, invoice: { id: source.invoiceId, submission_id: source.id, revision_id: source.revisionId,
    amount: total.toJSON().amount, currency: source.revision.currency, invoice_number: source.revision.invoiceNumber, purpose: source.revision.purpose,
    supplier_id: source.invoice.supplierId, occurred_on: day, emergency: source.emergency, submitted_by: source.submittedBy, approval_id: source.approval?.id ?? null,
    status: event.type === "SupplierInvoiceSubmitted" ? submittedState : event.type === "ApprovalRequested" ? "PENDING_APPROVAL" : historicalState },
    ...(source.approval ? { approval: { id: source.approval.id, requested_by: source.approval.requestedBy,
      status: event.type === "ApprovalRequested" || event.type === "SupplierInvoiceSubmitted" ? "PENDING" : source.approval.state } } : {}) };
  return { invoice, fields };
}
