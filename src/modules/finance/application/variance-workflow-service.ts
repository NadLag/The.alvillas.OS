import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { VarianceWorkflowEvent } from "@prisma/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { VarianceWorkflowRepository } from "../infrastructure/variance-workflow-repository";
import { decideVarianceWorkflow, projectVarianceWorkflow, varianceSourceReferenceSchema, varianceWorkflowVersionSchema,
  VarianceWorkflowConflictError, VarianceWorkflowSourceError, type VarianceSourceReference, type VarianceWorkflowCommand,
  type VarianceWorkflowSource, type VarianceWorkflowState } from "../domain/variance-workflow";
import type { FinanceActorContext } from "./finance-access";
import { varianceCommandInputSchema, varianceCommandReceiptSchema } from "../domain/variance-workspace";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { OutboxRepository } from "@/platform/events/outbox-repository";

export type VarianceSourceAccess = "view" | "history" | VarianceWorkflowCommand["operation"];
export type AuthorizedVarianceWorkflowSource = {
  baseline?: VarianceWorkflowSource["baseline"];
  facts: { kind: "MONEY" | "QUANTITY"; unit: string; currency: string | null; expected: string; actual: string; variance: string };
  recheck(): Promise<void>;
};
/** Production adapters must authorize original native facts, preserving held and current restrictions. */
export type VarianceSourceAuthority = (ctx: FinanceActorContext, source: VarianceSourceReference, tx: TenantTransaction,
  access: VarianceSourceAccess) => Promise<AuthorizedVarianceWorkflowSource>;
type Deps = { db: TenantTransactionRunner; authorizeSource: VarianceSourceAuthority; requestId?: string };
const id = z.uuid().transform(value => value.toLowerCase());
const commandInput = varianceCommandInputSchema;
const recoveryInput = z.object({ source: varianceSourceReferenceSchema, idempotencyKey: id }).strict();
const readInput = z.object({ source: varianceSourceReferenceSchema }).strict();
const historyInput = readInput.extend({ before: varianceWorkflowVersionSchema.refine(value => value !== "0").optional() }).strict();

function capture(ctx: FinanceActorContext) {
  if (ctx.actorId !== ctx.authContext.userAccountId || ctx.organizationId !== ctx.authContext.organizationId) throw new VarianceWorkflowSourceError();
  return { ...ctx, authContext: restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext)) };
}
function workflowState(row: VarianceWorkflowEvent | null): VarianceWorkflowState | null {
  return row ? { version: row.version.toString(), sourceFingerprint: row.sourceFingerprint, status: z.enum(["OPEN", "RESOLVED"]).parse(row.status),
    assignedTo: row.assignedTo, reason: row.reason, action: row.action, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt?.toISOString() ?? null } : null;
}
function receipt(row: VarianceWorkflowEvent, idempotent: boolean) {
  return varianceCommandReceiptSchema.parse({ requestId: row.id, eventId: row.id, state: "SUCCEEDED", failureCode: null, idempotencyKey: row.idempotencyKey,
    source: { provider: row.provider, id: row.sourceId }, version: row.version.toString(), operation: row.operation, intent: row.intent, idempotent });
}
async function inspect(ctx: FinanceActorContext, source: VarianceSourceReference, tx: TenantTransaction, deps: Deps, access: VarianceSourceAccess) {
  const authority = await deps.authorizeSource(ctx, source, tx, access), repository = new VarianceWorkflowRepository(tx, ctx.organizationId);
  const [native, latest] = await Promise.all([repository.source(source), repository.latest(source)]);
  if (!native) throw new VarianceWorkflowSourceError();
  const facts: VarianceWorkflowSource = { source, fingerprint: native.fingerprint, state: native.state, createdAt: native.createdAt,
    reason: native.reason ?? "", action: native.action, baseline: authority.baseline };
  const finance = new FinanceRepository(tx, ctx.organizationId), projection = projectVarianceWorkflow(facts, workflowState(latest), await finance.clock());
  const recheck = async () => {
    await authority.recheck();
    const current = await repository.source(source);
    if (!current || current.fingerprint !== native.fingerprint || current.sourceAuditId !== native.sourceAuditId || current.state !== native.state) throw new VarianceWorkflowConflictError();
  };
  await recheck(); return { repository, finance, native, latest, facts, projection, display: authority.facts, recheck };
}

/** Shared native inspection for the bounded center; every disclosure still needs its final recheck. */
export const inspectVarianceWorkflowSource = inspect;
export const captureVarianceWorkflowActor = capture;

export async function readVarianceWorkflow(context: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = capture(context), input = readInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const source = await inspect(ctx, input.source, tx, deps, "view");
    await auditRead(ctx, tx, input.source, "read", deps, { version: source.projection.version });
    await source.recheck(); return { ...source.projection, facts: source.display };
  });
}

async function auditRead(ctx: FinanceActorContext, tx: TenantTransaction, source: VarianceSourceReference, operation: "read" | "history_read" | "recovered", deps: Deps, metadata: { version?: string; count?: number }) {
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId,
    action: `${source.provider === "INVENTORY" ? "inventory" : "finance"}.variance_workflow.${operation}`,
    resourceType: "variance_workflow_source", resourceId: source.id, after: { provider: source.provider, ...metadata },
    requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
}

/** The source adapter authorizes original facts and audit access; assignment never grants either. */
export async function readVarianceWorkflowHistory(context: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = capture(context), input = historyInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const source = await inspect(ctx, input.source, tx, deps, "history");
    const rows = await source.repository.history(input.source, input.before === undefined ? undefined : BigInt(input.before));
    const page = rows.slice(0, 50);
    await auditRead(ctx, tx, input.source, "history_read", deps, { count: page.length });
    await source.recheck();
    return { rows: page.map(row => ({ id: row.id, version: row.version.toString(), operation: row.operation,
      sourceFingerprint: row.sourceFingerprint, status: row.status, assignedTo: row.assignedTo, actorId: row.actorId,
      reason: row.reason, action: row.action, resolvedBy: row.resolvedBy, resolvedAt: row.resolvedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() })),
      next: rows.length > 50 ? page[page.length - 1].version.toString() : null };
  });
}

/** Names need independent directory access; selecting a recipient never grants source access. */
export async function readVarianceWorkflowAssignees(context: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = capture(context), input = readInput.extend({ after: id.optional() }).strict().parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const source = await inspect(ctx, input.source, tx, deps, "ASSIGN");
    const directory = async () => recheckAccountAuthorization(ctx, tx, await source.finance.clock(), [
      { action: "view", resource: { type: "identity", organizationId: ctx.organizationId, dataClass: "sensitive" }, organizationOnly: true }
    ], new VarianceWorkflowSourceError());
    await directory();
    const rows = await source.repository.assignees(input.after), page = rows.slice(0, 50);
    await auditRead(ctx, tx, input.source, "read", deps, { count: page.length });
    await directory(); await source.recheck();
    return { items: page.map(row => ({ id: row.id, name: row.person.displayName })), next: rows.length > 50 ? page[page.length - 1].id : null };
  });
}

export async function commandVarianceWorkflow(context: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = capture(context), input = commandInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new VarianceWorkflowRepository(tx, ctx.organizationId);
    await repository.lockActor(ctx.actorId, input.idempotencyKey);
    const hash = await repository.intentHash(input.intent), existing = await repository.byActorNonce(ctx.actorId, input.idempotencyKey);
    if (existing) {
      const source = await inspect(ctx, input.intent.source, tx, deps, "view");
      if (existing.requestHash !== hash || existing.provider !== input.intent.source.provider || existing.sourceId !== input.intent.source.id) throw new VarianceWorkflowConflictError();
      await source.recheck(); return receipt(existing, true);
    }
    await repository.lockSource(input.intent.source);
    const source = await inspect(ctx, input.intent.source, tx, deps, input.intent.operation), now = await source.finance.clock();
    const eligible = input.intent.operation !== "ASSIGN" || input.intent.assignedTo === null || Boolean(await repository.eligibleAssignee(input.intent.assignedTo));
    const decision = decideVarianceWorkflow({ command: input.intent, source: source.facts, latest: workflowState(source.latest), actorId: ctx.actorId, now, assigneeEligible: eligible });
    const after = decision.after, provider = input.intent.source.provider;
    const row = await repository.create({ organizationId: ctx.organizationId, provider, sourceId: input.intent.source.id,
      varianceId: provider === "OTA" ? input.intent.source.id : null, bankEntryId: provider === "BANK" ? input.intent.source.id : null,
      claimId: provider === "STAFF" ? input.intent.source.id : null, stocktakeId: provider === "INVENTORY" ? input.intent.source.id : null,
      sourceAuditId: source.native.sourceAuditId, sourceFingerprint: after.sourceFingerprint, version: BigInt(after.version), operation: decision.operation,
      status: after.status, assignedTo: after.assignedTo, reason: after.reason, action: after.action, resolvedBy: after.resolvedBy,
      resolvedAt: after.resolvedAt ? new Date(after.resolvedAt) : null, actorId: ctx.actorId, idempotencyKey: input.idempotencyKey, requestHash: hash,
      intent: input.intent, createdAt: now });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId,
      action: `${provider === "INVENTORY" ? "inventory" : "finance"}.variance_workflow.${decision.operation.toLowerCase()}`,
      resourceType: "variance_workflow_event", resourceId: row.id, before: { version: decision.beforeVersion },
      after: { eventId: row.id, provider, sourceId: row.sourceId, version: after.version, operation: decision.operation,
        sourceFingerprint: after.sourceFingerprint, status: after.status, assignedTo: after.assignedTo, reason: after.reason, action: after.action,
        resolvedBy: after.resolvedBy, resolvedAt: after.resolvedAt }, reason: after.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
    if (decision.operation !== "ASSIGN") await new OutboxRepository(tx, ctx.organizationId).append(
      decision.operation === "RESOLVE" ? "VarianceResolved" : "VarianceOpened", { varianceWorkflowEventId: row.id }, `variance-workflow:${row.id}`, now);
    await repository.flushGuards(); await source.recheck(); return receipt(row, false);
  }, { timeout: 120000 });
}

export async function recoverVarianceWorkflow(context: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = capture(context), input = recoveryInput.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    // A missing receipt is conclusive only after the same actor/nonce transaction has ended.
    await new VarianceWorkflowRepository(tx, ctx.organizationId).lockActor(ctx.actorId, input.idempotencyKey);
    const source = await inspect(ctx, input.source, tx, deps, "view"), row = await source.repository.byActorNonce(ctx.actorId, input.idempotencyKey);
    if (row && (row.provider !== input.source.provider || row.sourceId !== input.source.id)) throw new VarianceWorkflowSourceError();
    await auditRead(ctx, tx, input.source, "recovered", deps, {});
    await source.recheck(); return { receipt: row ? receipt(row, true) : null };
  });
}
