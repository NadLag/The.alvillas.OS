import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierInvoiceRecognitionRequestRepository, type RecognitionOutcomeState } from "../infrastructure/supplier-invoice-recognition-request-repository";
import type { FinanceActorContext } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import { prepareSupplierInvoiceRecognition, recognizeSupplierInvoice, supplierInvoiceRecognitionInput } from "./supplier-invoice-recognition";

export const supplierInvoiceRecognitionRequested = "SupplierInvoiceRecognitionRequested";
const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict();
const eventPayload = z.object({ requestId: z.uuid() }).strict();
const eventKey = (id: string) => `supplier-invoice-recognition:${id}:requested`;
type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Request = NonNullable<Awaited<ReturnType<SupplierInvoiceRecognitionRequestRepository["find"]>>>;
const commandFor = (request: Request) => ({ id: request.invoiceId, expectedVersion: request.invoiceVersion, idempotencyKey: request.idempotencyKey,
  reason: request.reason, currentPeriod: request.currentPeriod });
const actorFor = (request: Request): FinanceActorContext => {
  try { return { organizationId: request.organizationId, actorId: request.requestedBy, authContext: restoreAuthorizationCap(request.authorizationCap) }; }
  catch { throw new SupplierInvoiceAccessError(); }
};

/** Freeze the caller's restrictions and enqueue only after checking the actual immutable approved source. */
export async function requestSupplierInvoiceRecognition(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = supplierInvoiceRecognitionInput.parse(raw), cap = captureAuthorizationCap(ctx.authContext);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const prepared = await prepareSupplierInvoiceRecognition(ctx, input, tx);
    const requests = new SupplierInvoiceRecognitionRequestRepository(tx, ctx.organizationId);
    await requests.lockKey(input.idempotencyKey);
    const existing = await requests.byKey(input.idempotencyKey);
    if (existing) {
      if (existing.requestFingerprint !== prepared.fingerprint || existing.invoiceId !== input.id || existing.requestedBy !== ctx.actorId) throw new SupplierInvoiceConflictError();
      await prepared.recheck(await prepared.finance.clock());
      return { requestId: existing.id, id: input.id, state: existing.outcome?.state ?? "PENDING", idempotent: true };
    }
    const request = await requests.create({ invoiceId: input.id, submissionId: prepared.source.id, invoiceVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey, requestFingerprint: prepared.fingerprint, reason: input.reason, currentPeriod: input.currentPeriod,
      requestedBy: ctx.actorId, authorizationCap: cap });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.supplier_invoice.recognition_requested",
      resourceType: "supplier_invoice", resourceId: input.id, after: { recognitionRequestId: request.id, submissionId: request.submissionId },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await prepared.finance.clock() });
    const outbox = new OutboxRepository(tx, ctx.organizationId);
    await outbox.append(supplierInvoiceRecognitionRequested, { requestId: request.id }, eventKey(request.id), request.requestedAt);
    await outbox.requestDispatch(`supplier-invoice-recognition:${request.id}:dispatch`);
    await requests.flushGuards();
    await prepared.recheck(await prepared.finance.clock());
    return { requestId: request.id, id: input.id, state: "PENDING" as const, idempotent: false };
  }, { timeout: 120000 });
}

async function requestFromReference(tx: TenantTransaction, reference: z.infer<typeof referenceSchema>) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId);
  if (!event || event.type !== supplierInvoiceRecognitionRequested) throw new SupplierInvoiceAccessError();
  const payload = eventPayload.safeParse(event.payload);
  if (!payload.success || event.idempotencyKey !== eventKey(payload.data.requestId)) throw new SupplierInvoiceAccessError();
  const requests = new SupplierInvoiceRecognitionRequestRepository(tx, reference.organizationId);
  await requests.lockRequest(payload.data.requestId);
  const request = await requests.find(payload.data.requestId);
  if (!request || event.occurredAt.getTime() !== request.requestedAt.getTime()) throw new SupplierInvoiceAccessError();
  return { request, requests };
}

async function writeOutcome(tx: TenantTransaction, request: Request, state: RecognitionOutcomeState, recognitionId: string | null, failureCode: string | null, traceId: string) {
  const id = crypto.randomUUID(), finance = new FinanceRepository(tx, request.organizationId);
  // Recognition flushes deferred journal guards. Write the receipt audit before its potentially immediate constraint trigger.
  await writeAuditEvent(tx, { organizationId: request.organizationId, actorId: request.requestedBy, action: "finance.supplier_invoice.recognition_completed",
    resourceType: "supplier_invoice", resourceId: request.invoiceId, after: { recognitionRequestId: request.id, recognitionOutcomeId: id, state, recognitionId, failureCode },
    reason: request.reason, requestId: traceId, occurredAt: await finance.clock() });
  return new SupplierInvoiceRecognitionRequestRepository(tx, request.organizationId).outcome({ id, requestId: request.id, state, recognitionId, failureCode });
}

/** The claim and its success receipt commit together. Event redelivery never creates another claim. */
export async function executeSupplierInvoiceRecognitionReference(raw: unknown, deps: Deps = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, traceId = deps.requestId ?? crypto.randomUUID();
  try {
    return await withTenant(db, reference.organizationId, async tx => {
      const { request, requests } = await requestFromReference(tx, reference);
      if (request.outcome) return { requestId: request.id, state: request.outcome.state, idempotent: true };
      const ctx = actorFor(request), command = commandFor(request);
      const result = await recognizeSupplierInvoice(ctx, command, { db: { $transaction: work => work(tx) }, requestId: traceId });
      await writeOutcome(tx, request, "SUCCEEDED", result.recognitionId, null, traceId);
      await requests.flushGuards();
      const prepared = await prepareSupplierInvoiceRecognition(ctx, command, tx);
      await prepared.recheck(await prepared.finance.clock());
      return { requestId: request.id, state: "SUCCEEDED", idempotent: false };
    }, { timeout: 120000 });
  } catch (error) {
    const failure = error instanceof SupplierInvoiceAccessError ? { state: "DENIED" as const, code: "ACCESS_DENIED" } :
      error instanceof SupplierInvoiceConflictError ? { state: "CONFLICT" as const, code: "SOURCE_CHANGED" } :
      error instanceof AccountingPeriodClosedError ? { state: "CONFLICT" as const, code: "PERIOD_CLOSED" } :
      error instanceof ExpensePolicyUnavailableError ? { state: "CONFLICT" as const, code: "POLICY_UNAVAILABLE" } : null;
    if (!failure) throw error;
    return finishFailedReference(reference, failure.state, failure.code, { db, requestId: traceId });
  }
}

async function finishFailedReference(reference: z.infer<typeof referenceSchema>, state: Exclude<RecognitionOutcomeState, "SUCCEEDED">, failureCode: string, deps: Deps) {
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const { request, requests } = await requestFromReference(tx, reference);
    if (request.outcome) return { requestId: request.id, state: request.outcome.state, idempotent: true };
    await writeOutcome(tx, request, state, null, failureCode, deps.requestId ?? crypto.randomUUID());
    await requests.flushGuards();
    return { requestId: request.id, state, idempotent: false };
  });
}

/** Called only after the existing job infrastructure exhausts transient retries. */
export async function failSupplierInvoiceRecognitionReference(raw: unknown, deps: Deps = {}) {
  return finishFailedReference(referenceSchema.parse(raw), "FAILED", "EXECUTION_UNAVAILABLE", deps);
}
