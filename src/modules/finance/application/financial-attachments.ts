import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { financialAttachmentAuthorityChecks } from "@/platform/authz/financial-attachment-resource";
import { present } from "@/platform/authz/present";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { FinancialAttachmentRepository } from "../infrastructure/financial-attachment-repository";
import type { FinancialAttachmentObjectStore } from "../infrastructure/financial-attachment-storage";
import { financialAttachmentPolicyKey, financialAttachmentPolicySchema } from "../domain/financial-attachment-policy";
import { financialAttachmentItemSchema, financialAttachmentHistorySchema, financialAttachmentEditorSchema } from "../domain/financial-attachment-read-model";
import { financialAttachmentIntentSchema, financialAttachmentReferenceSchema, financialAttachmentListSchema, validateFinancialAttachmentBytes,
  FinancialAttachmentAccessError, FinancialAttachmentConfigurationError, FinancialAttachmentConflictError, FinancialAttachmentSourceError,
  FinancialAttachmentValidationError, FinancialAttachmentRateLimitError } from "../domain/financial-attachment";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db: TenantTransactionRunner; objects?: FinancialAttachmentObjectStore; requestId?: string };
type Admission = NonNullable<Awaited<ReturnType<FinancialAttachmentRepository["admission"]>>>;
type Attached = NonNullable<Awaited<ReturnType<FinancialAttachmentRepository["attachment"]>>>;
const savedPolicySchema = z.object({ id: z.uuid(), version: z.number().int().positive(), value: financialAttachmentPolicySchema }).strict();
const copyActor = (ctx: FinanceActorContext): FinanceActorContext => {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new FinancialAttachmentAccessError();
  return { ...ctx, authContext: restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext)) };
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
async function context(ctx: FinanceActorContext, tx: TenantTransaction, transactionId: string, action: "create" | "view" | "export", rootId?: string) {
  const repository = new FinancialAttachmentRepository(tx, ctx.organizationId), now = await repository.clock(), native = await repository.source(transactionId);
  if (!native) throw new FinancialAttachmentAccessError();
  const checks = financialAttachmentAuthorityChecks(native.source, action, rootId); if (!checks) throw new FinancialAttachmentAccessError();
  const recheck = (additional: Parameters<typeof recheckAccountAuthorization>[3] = []) => recheckAccountAuthorization(ctx, tx, now, [...checks, ...native.extraChecks, ...additional], new FinancialAttachmentAccessError());
  await recheck();
  const rule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: financialAttachmentPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
  if (!rule) throw new FinancialAttachmentConfigurationError(); const parsed = financialAttachmentPolicySchema.safeParse(rule.value);
  if (!parsed.success) throw new FinancialAttachmentConfigurationError();
  const policySnapshot = { id: rule.id, version: rule.version, value: parsed.data };
  return { repository, now, native, policy: parsed.data, policySnapshot, policyIdentity: commandFingerprint(policySnapshot), recheck };
}
function identity(ctx: FinanceActorContext, row: Pick<Admission, "transactionId" | "id" | "contentType" | "fileSize" | "sha256">) { return { organizationId: ctx.organizationId, transactionId: row.transactionId,
  id: row.id, contentType: row.contentType, fileSize: row.fileSize, sha256: row.sha256 }; }
function presentAttachment(ctx: FinanceActorContext, current: Awaited<ReturnType<typeof context>>, row: Attached) {
  const resource = financialAttachmentAuthorityChecks(current.native.source, "view", row.rootId)?.at(-1)?.resource;
  if (!resource) throw new FinancialAttachmentAccessError();
  const data = { id: row.id, rootId: row.rootId, transactionId: row.transactionId, version: row.version, kind: row.admission.kind,
    fileName: row.admission.fileName, contentType: row.admission.contentType, fileSize: row.admission.fileSize, sha256: row.admission.sha256,
    reason: row.admission.reason, createdAt: row.createdAt.toISOString(), supersedesId: row.supersedesId, supersededById: row.next?.id ?? null };
  return financialAttachmentItemSchema.parse(present({ ...ctx.authContext, visibleDataClasses: new Set(["financial"] as const) }, "view", { ...resource, data },
    Object.fromEntries(Object.keys(data).map(key => [key, { dataClass: "financial" as const }]))));
}
async function audit(ctx: FinanceActorContext, tx: TenantTransaction, row: Admission, action: string, now: Date, deps: Deps, after: Record<string, unknown>) {
  await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action, resourceType: "financial_attachment", resourceId: row.id,
    after: { transactionId: row.transactionId, sha256: row.sha256, ...after }, reason: row.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: now });
}
async function checkAdmission(ctx: FinanceActorContext, tx: TenantTransaction, row: Admission) {
  if (row.createdBy !== ctx.actorId) throw new FinancialAttachmentAccessError();
  const current = await context(ctx, tx, row.transactionId, "create", row.supersedes?.rootId);
  if (!row.attachment) {
    const savedPolicy = savedPolicySchema.safeParse(row.policySnapshot);
    if (row.sourceFingerprint !== current.native.identity || !savedPolicy.success || commandFingerprint(savedPolicy.data) !== current.policyIdentity || row.expiresAt <= current.now) throw new FinancialAttachmentConflictError();
  }
  return current;
}

/** Rate admission commits before body transport/storage, so failures cannot refund an actor's budget. */
export async function admitFinancialAttachment(actor: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = copyActor(actor), input = financialAttachmentIntentSchema.parse(raw), fingerprint = commandFingerprint(input);
  const admitted = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new FinancialAttachmentRepository(tx, ctx.organizationId), previous = input.supersedesId ? await repository.attachment(input.supersedesId) : null;
    if (input.supersedesId && (!previous || previous.transactionId !== input.transactionId || previous.admission.kind !== input.kind)) throw new FinancialAttachmentAccessError();
    const current = await context(ctx, tx, input.transactionId, "create", previous?.rootId);
    if (!current.policy.content_types.includes(input.contentType) || input.fileSize > current.policy.max_bytes) throw new FinancialAttachmentValidationError();
    const decision = await consumeRateLimit(tx, ctx.organizationId, { key: "finance.financial_attachment:" + ctx.actorId, limit: current.policy.rate_limit.requests,
      windowSeconds: current.policy.rate_limit.window_seconds, now: current.now }); return { decision, source: current.native.identity, policy: current.policyIdentity };
  });
  if (!admitted.decision.allowed) throw new FinancialAttachmentRateLimitError(admitted.decision.resetAt);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new FinancialAttachmentRepository(tx, ctx.organizationId); await repository.lock(input.transactionId);
    const existing = await repository.byNonce(ctx.actorId, input.idempotencyKey);
    if (existing) { if (existing.requestFingerprint !== fingerprint) throw new FinancialAttachmentConflictError(); await checkAdmission(ctx, tx, existing);
      return { id: existing.id, expiresAt: existing.expiresAt.toISOString(), attached: Boolean(existing.attachment) }; }
    const previous = input.supersedesId ? await repository.attachment(input.supersedesId) : null;
    if (input.supersedesId && (!previous || previous.next)) throw new FinancialAttachmentConflictError();
    const current = await context(ctx, tx, input.transactionId, "create", previous?.rootId);
    if (current.native.identity !== admitted.source || current.policyIdentity !== admitted.policy) throw new FinancialAttachmentConflictError();
    const row = await repository.appendAdmission({ ...input, requestFingerprint: fingerprint, sourceFingerprint: current.native.identity,
      policyRuleId: current.policySnapshot.id, policySnapshot: json(current.policySnapshot), createdBy: ctx.actorId, createdAt: current.now,
      expiresAt: new Date(current.now.getTime() + current.policy.intent_lifetime_seconds * 1000) });
    await audit(ctx, tx, row, "finance.financial_attachment.admitted", current.now, deps, { requestFingerprint: fingerprint });
    const final = await context(ctx, tx, row.transactionId, "create", previous?.rootId);
    if (final.native.identity !== current.native.identity || final.policyIdentity !== current.policyIdentity) throw new FinancialAttachmentConflictError();
    return { id: row.id, expiresAt: row.expiresAt.toISOString(), attached: false };
  });
}

export async function uploadFinancialAttachment(actor: FinanceActorContext, raw: unknown, bytes: Uint8Array, deps: Deps) {
  const ctx = copyActor(actor), { id } = financialAttachmentReferenceSchema.parse(raw);
  const admitted = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new FinancialAttachmentRepository(tx, ctx.organizationId), row = await repository.admission(id);
    if (!row) throw new FinancialAttachmentAccessError(); const current = await checkAdmission(ctx, tx, row);
    if (bytes.length !== row.fileSize || createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new FinancialAttachmentValidationError();
    const parsed = financialAttachmentIntentSchema.parse({ transactionId: row.transactionId, idempotencyKey: row.idempotencyKey, kind: row.kind,
      fileName: row.fileName, contentType: row.contentType, fileSize: row.fileSize, sha256: row.sha256, supersedesId: row.supersedesId, reason: row.reason });
    validateFinancialAttachmentBytes(bytes, parsed);
    if (row.attachment) { const attached = await repository.attachment(id); if (!attached) throw new FinancialAttachmentSourceError();
      const visible = await context(ctx, tx, row.transactionId, "view", attached.rootId); return { row, ttl: current.policy.storage_read_ttl_seconds, result: presentAttachment(ctx, visible, attached) }; }
    return { row, ttl: current.policy.storage_read_ttl_seconds, result: null };
  });
  if (admitted.result) return admitted.result;
  if (!deps.objects) throw new FinancialAttachmentConfigurationError();
  const stored = await deps.objects.put(identity(ctx, admitted.row), bytes, admitted.ttl);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new FinancialAttachmentRepository(tx, ctx.organizationId); await repository.lock(admitted.row.transactionId);
    const row = await repository.admission(id); if (!row) throw new FinancialAttachmentAccessError();
    const current = await checkAdmission(ctx, tx, row);
    if (!row.attachment) {
      const previous = row.supersedesId ? await repository.attachment(row.supersedesId) : null;
      if (row.supersedesId && (!previous || previous.next)) throw new FinancialAttachmentConflictError();
      const rootId = previous?.rootId ?? id, version = (previous?.version ?? 0) + 1;
      await repository.appendAttachment({ id, transactionId: row.transactionId, rootId, supersedesId: row.supersedesId, version, ...stored, createdAt: current.now });
      await audit(ctx, tx, row, "finance.financial_attachment.attached", current.now, deps, { rootId, version, cipherSha256: stored.cipherSha256 });
    }
    const attached = await repository.attachment(id); if (!attached) throw new FinancialAttachmentSourceError();
    const visible = await context(ctx, tx, row.transactionId, "create", attached.rootId);
    if (visible.native.identity !== current.native.identity || visible.policyIdentity !== current.policyIdentity) throw new FinancialAttachmentConflictError();
    return presentAttachment(ctx, visible, attached);
  });
}

export async function readFinancialAttachments(actor: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = copyActor(actor), input = financialAttachmentListSchema.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await context(ctx, tx, input.transactionId, "view"), rows = await current.repository.history(input.transactionId, input.before);
    const checks = rows.slice(0, 30).flatMap(row => {
      const checks = financialAttachmentAuthorityChecks(current.native.source, "view", row.rootId); if (!checks) throw new FinancialAttachmentAccessError(); return checks;
    });
    await current.recheck(checks); const items = rows.slice(0, 30).map(row => presentAttachment(ctx, current, row));
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.financial_attachment.history_read", resourceType: "financial_attachment",
      resourceId: rows[0]?.id ?? null, after: { transactionId: input.transactionId, count: items.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
    const final = await context(ctx, tx, input.transactionId, "view");
    if (final.native.identity !== current.native.identity || final.policyIdentity !== current.policyIdentity) throw new FinancialAttachmentConflictError();
    await final.recheck(checks); return financialAttachmentHistorySchema.parse({ transaction: current.native.transaction, items, next: rows.length > 30 ? rows[29].id : null,
      contentTypes: current.policy.content_types, maxBytes: current.policy.max_bytes });
  });
}

export async function downloadFinancialAttachment(actor: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = copyActor(actor), { id } = financialAttachmentReferenceSchema.parse(raw);
  const captured = await withTenant(deps.db, ctx.organizationId, async tx => {
    const repository = new FinancialAttachmentRepository(tx, ctx.organizationId), row = await repository.attachment(id); if (!row) throw new FinancialAttachmentAccessError();
    const current = await context(ctx, tx, row.transactionId, "export", row.rootId);
    await context(ctx, tx, row.transactionId, "view", row.rootId); return { row, source: current.native.identity, policy: current.policyIdentity, ttl: current.policy.storage_read_ttl_seconds };
  });
  if (!deps.objects) throw new FinancialAttachmentConfigurationError();
  const bytes = await deps.objects.read(identity(ctx, captured.row.admission), captured.row, captured.ttl);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await context(ctx, tx, captured.row.transactionId, "export", captured.row.rootId);
    await context(ctx, tx, captured.row.transactionId, "view", captured.row.rootId);
    if (current.native.identity !== captured.source || current.policyIdentity !== captured.policy) throw new FinancialAttachmentConflictError();
    await audit(ctx, tx, { ...captured.row.admission, attachment: captured.row, supersedes: null }, "finance.financial_attachment.downloaded", current.now, deps,
      { rootId: captured.row.rootId, version: captured.row.version });
    const final = await context(ctx, tx, captured.row.transactionId, "export", captured.row.rootId);
    if (final.native.identity !== captured.source || final.policyIdentity !== captured.policy) throw new FinancialAttachmentConflictError();
    return { bytes, contentType: captured.row.admission.contentType, fileName: captured.row.admission.fileName };
  });
}

const editorSchema = z.object({ query: z.string().trim().max(120).default(""), before: z.uuid().optional() }).strict();
export async function readFinancialAttachmentEditor(actor: FinanceActorContext, raw: unknown, deps: Deps) {
  const ctx = copyActor(actor), input = editorSchema.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const stored = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
    if ([ctx.authContext, stored].some(authority => ["financial_attachment:view", "financial_transaction:view"].some(key => !authority.permissions.has(key)))) throw new FinancialAttachmentAccessError();
    const repository = new FinancialAttachmentRepository(tx, ctx.organizationId), candidates = await repository.candidates(input.query, input.before), items = [], checks = [];
    for (const candidate of candidates.slice(0, 30)) { try { const current = await context(ctx, tx, candidate.id, "view"); items.push(current.native.transaction);
      checks.push(...financialAttachmentAuthorityChecks(current.native.source, "view") ?? [], ...current.native.extraChecks); }
      catch (error) { if (!(error instanceof FinancialAttachmentAccessError)) throw error; } }
    await recheckAccountAuthorization(ctx, tx, await repository.clock(), checks, new FinancialAttachmentAccessError());
    return financialAttachmentEditorSchema.parse({ items, next: candidates.length > 30 ? candidates[29].id : null });
  });
}
