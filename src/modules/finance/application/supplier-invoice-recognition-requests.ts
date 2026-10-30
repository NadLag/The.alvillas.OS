import { createHash } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { SupplierInvoiceRecognitionRequestRepository, type RecognitionOutcomeState, type SupplierInvoiceFinancialOperation } from "../infrastructure/supplier-invoice-recognition-request-repository";
import type { FinanceActorContext } from "./finance-access";
import { SupplierInvoiceAccessError, SupplierInvoiceConflictError } from "./supplier-invoice-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import { prepareSupplierInvoiceRecognition, recognizeSupplierInvoice, supplierInvoiceRecognitionInput } from "./supplier-invoice-recognition";
import { prepareSupplierInvoiceReversal, voidSupplierInvoiceClaim } from "./supplier-payment-service";
import { supplierInvoiceReversalInput } from "../domain/supplier-payment";

export const supplierInvoiceRecognitionRequested = "SupplierInvoiceRecognitionRequested";
export const supplierInvoiceReversalRequested = "SupplierInvoiceReversalRequested";
const referenceSchema = z.object({ organizationId: z.uuid(), outboxEventId: z.uuid() }).strict();
const eventPayload = z.object({ requestId: z.uuid() }).strict();
const eventPrefix = (operation: SupplierInvoiceFinancialOperation) => operation === "RECOGNIZE" ? "supplier-invoice-recognition" : "supplier-invoice-reversal";
const eventType = (operation: SupplierInvoiceFinancialOperation) => operation === "RECOGNIZE" ? supplierInvoiceRecognitionRequested : supplierInvoiceReversalRequested;
const eventKey = (id: string, operation: SupplierInvoiceFinancialOperation) => `${eventPrefix(operation)}:${id}:requested`;
const operationSchema = z.enum(["RECOGNIZE", "REVERSE"]);
type Deps = { db?: TenantTransactionRunner; requestId?: string; eventType?: string };
type Request = NonNullable<Awaited<ReturnType<SupplierInvoiceRecognitionRequestRepository["find"]>>>;
const commandFor = (request: Request) => ({ id: request.invoiceId, expectedVersion: request.invoiceVersion, idempotencyKey: request.idempotencyKey,
  reason: request.reason, ...(request.operation === "RECOGNIZE" ? { currentPeriod: request.currentPeriod } : {}) });
const actorFor = (request: Request): FinanceActorContext => {
  try { return { organizationId: request.organizationId, actorId: request.requestedBy, authContext: restoreAuthorizationCap(request.authorizationCap) }; }
  catch { throw new SupplierInvoiceAccessError(); }
};

async function prepareOperation(ctx: FinanceActorContext, raw: unknown, operation: SupplierInvoiceFinancialOperation, tx: TenantTransaction) {
  if (operation === "RECOGNIZE") {
    const prepared = await prepareSupplierInvoiceRecognition(ctx, raw, tx);
    return { ...prepared, currentPeriod: prepared.input.currentPeriod, completedRecognitionId: null as string | null };
  }
  const prepared = await prepareSupplierInvoiceReversal(ctx, raw, tx);
  return { ...prepared, currentPeriod: false, recheck: prepared.recheckReversal,
    fingerprint: createHash("sha256").update(JSON.stringify({ operation, actorId: ctx.actorId, ...prepared.input })).digest("hex"),
    completedRecognitionId: prepared.reversals.length ? prepared.existing!.id : null };
}

/** Both operations capture the original caller and reuse the same immutable request, outbox and worker. */
async function requestFinancialOperation(ctx: FinanceActorContext, raw: unknown, operation: SupplierInvoiceFinancialOperation, deps: Deps) {
  const input = (operation === "RECOGNIZE" ? supplierInvoiceRecognitionInput : supplierInvoiceReversalInput).parse(raw), cap = captureAuthorizationCap(ctx.authContext);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const prepared = await prepareOperation(ctx, input, operation, tx);
    const requests = new SupplierInvoiceRecognitionRequestRepository(tx, ctx.organizationId);
    await requests.lockKey(input.idempotencyKey);
    const existing = await requests.byKey(input.idempotencyKey);
    if (existing) {
      if (existing.operation !== operation || existing.requestFingerprint !== prepared.fingerprint || existing.invoiceId !== input.id || existing.requestedBy !== ctx.actorId) throw new SupplierInvoiceConflictError();
      await prepared.recheck(await prepared.finance.clock());
      return { requestId: existing.id, id: input.id, state: existing.outcome?.state ?? "PENDING", idempotent: true };
    }
    const request = await requests.create({ invoiceId: input.id, submissionId: prepared.source.id, invoiceVersion: input.expectedVersion,
      idempotencyKey: input.idempotencyKey, requestFingerprint: prepared.fingerprint, reason: input.reason, currentPeriod: prepared.currentPeriod,
      requestedBy: ctx.actorId, authorizationCap: cap, operation });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: operation === "RECOGNIZE" ? "finance.supplier_invoice.recognition_requested" : "finance.supplier_invoice.reversal_requested",
      resourceType: "supplier_invoice", resourceId: input.id, after: { [operation === "RECOGNIZE" ? "recognitionRequestId" : "reversalRequestId"]: request.id, submissionId: request.submissionId },
      reason: input.reason, requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await prepared.finance.clock() });
    const outbox = new OutboxRepository(tx, ctx.organizationId);
    await outbox.append(eventType(operation), { requestId: request.id }, eventKey(request.id, operation), request.requestedAt);
    await outbox.requestDispatch(`${eventPrefix(operation)}:${request.id}:dispatch`);
    // Adopt an exact pre-queue cancellation atomically; never leave pending work that contradicts committed money.
    if (prepared.completedRecognitionId) await writeOutcome(tx, { ...request, outcome: null }, "SUCCEEDED", prepared.completedRecognitionId, null, deps.requestId ?? crypto.randomUUID());
    await requests.flushGuards();
    await prepared.recheck(await prepared.finance.clock());
    return { requestId: request.id, id: input.id, state: prepared.completedRecognitionId ? "SUCCEEDED" as const : "PENDING" as const, idempotent: Boolean(prepared.completedRecognitionId) };
  }, { timeout: 120000 });
}

export function requestSupplierInvoiceRecognition(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  return requestFinancialOperation(ctx, raw, "RECOGNIZE", deps);
}
export function requestSupplierInvoiceReversal(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  return requestFinancialOperation(ctx, raw, "REVERSE", deps);
}

async function requestFromReference(tx: TenantTransaction, reference: z.infer<typeof referenceSchema>, expectedEventType?: string) {
  const event = await new OutboxRepository(tx, reference.organizationId).event(reference.outboxEventId);
  if (!event || ![supplierInvoiceRecognitionRequested, supplierInvoiceReversalRequested].includes(event.type) || expectedEventType && event.type !== expectedEventType) throw new SupplierInvoiceAccessError();
  const payload = eventPayload.safeParse(event.payload);
  if (!payload.success) throw new SupplierInvoiceAccessError();
  const requests = new SupplierInvoiceRecognitionRequestRepository(tx, reference.organizationId);
  await requests.lockRequest(payload.data.requestId);
  const request = await requests.find(payload.data.requestId);
  if (!request) throw new SupplierInvoiceAccessError();
  const operation = operationSchema.safeParse(request.operation);
  if (!operation.success || event.type !== eventType(operation.data) || event.idempotencyKey !== eventKey(request.id, operation.data) || event.occurredAt.getTime() !== request.requestedAt.getTime()) throw new SupplierInvoiceAccessError();
  return { request, requests };
}

async function writeOutcome(tx: TenantTransaction, request: Request, state: RecognitionOutcomeState, recognitionId: string | null, failureCode: string | null, traceId: string) {
  const id = crypto.randomUUID(), finance = new FinanceRepository(tx, request.organizationId);
  // Recognition flushes deferred journal guards. Write the receipt audit before its potentially immediate constraint trigger.
  await writeAuditEvent(tx, { organizationId: request.organizationId, actorId: request.requestedBy, action: request.operation === "RECOGNIZE" ? "finance.supplier_invoice.recognition_completed" : "finance.supplier_invoice.reversal_completed",
    resourceType: "supplier_invoice", resourceId: request.invoiceId, after: { [request.operation === "RECOGNIZE" ? "recognitionRequestId" : "reversalRequestId"]: request.id,
      [request.operation === "RECOGNIZE" ? "recognitionOutcomeId" : "reversalOutcomeId"]: id, state, recognitionId, failureCode },
    reason: request.reason, requestId: traceId, occurredAt: await finance.clock() });
  return new SupplierInvoiceRecognitionRequestRepository(tx, request.organizationId).outcome({ id, requestId: request.id, state, recognitionId, failureCode });
}

/** The claim and its success receipt commit together. Event redelivery never creates another claim. */
export async function executeSupplierInvoiceRecognitionReference(raw: unknown, deps: Deps = {}) {
  const reference = referenceSchema.parse(raw), db = deps.db ?? prisma, traceId = deps.requestId ?? crypto.randomUUID();
  try {
    return await withTenant(db, reference.organizationId, async tx => {
      const { request, requests } = await requestFromReference(tx, reference, deps.eventType);
      if (request.outcome) return { requestId: request.id, state: request.outcome.state, idempotent: true };
      const ctx = actorFor(request), command = commandFor(request);
      const execute = request.operation === "RECOGNIZE" ? recognizeSupplierInvoice : voidSupplierInvoiceClaim;
      const result = await execute(ctx, command, { db: { $transaction: work => work(tx) }, requestId: traceId });
      await writeOutcome(tx, request, "SUCCEEDED", result.recognitionId, null, traceId);
      await requests.flushGuards();
      const prepared = await prepareOperation(ctx, command, operationSchema.parse(request.operation), tx);
      await prepared.recheck(await prepared.finance.clock());
      return { requestId: request.id, state: "SUCCEEDED", idempotent: false };
    }, { timeout: 120000 });
  } catch (error) {
    const failure = error instanceof SupplierInvoiceAccessError ? { state: "DENIED" as const, code: "ACCESS_DENIED" } :
      error instanceof SupplierInvoiceConflictError ? { state: "CONFLICT" as const, code: "SOURCE_CHANGED" } :
      error instanceof AccountingPeriodClosedError ? { state: "CONFLICT" as const, code: "PERIOD_CLOSED" } :
      error instanceof ExpensePolicyUnavailableError ? { state: "CONFLICT" as const, code: "POLICY_UNAVAILABLE" } : null;
    if (!failure) throw error;
    return finishFailedReference(reference, failure.state, failure.code, { db, requestId: traceId, eventType: deps.eventType });
  }
}

async function finishFailedReference(reference: z.infer<typeof referenceSchema>, state: Exclude<RecognitionOutcomeState, "SUCCEEDED">, failureCode: string, deps: Deps) {
  return withTenant(deps.db ?? prisma, reference.organizationId, async tx => {
    const { request, requests } = await requestFromReference(tx, reference, deps.eventType);
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
