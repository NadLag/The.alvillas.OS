import { createHash, randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicyKey, bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";
import { R2StorageProvider } from "@/platform/providers/real";
import type { StorageProvider } from "@/platform/providers";
import { bankStatementImportInput, bankStatementReviewInput, bankStatementRecoveryInput, bankStatementPolicySnapshotSchema, bankStatementBankIdentity, bankStatementLineIdentity, parseBankStatementSource,
  BankStatementAccessError, BankStatementMissingError, BankStatementValidationError, BankStatementConfigurationError, BankStatementConflictError, BankStatementStorageError, type ParsedBankStatement } from "../domain/bank-statement-import";
import { BankStatementRepository } from "../infrastructure/bank-statement-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { FinancialTransferRepository } from "../infrastructure/financial-transfer-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Storage = StorageProvider & { createSignedDownloadUrl(input: { key: string; expiresInSeconds: number }): Promise<{ url: string }> };
type Deps = { db?: TenantTransactionRunner; requestId?: string; storage?: Storage; transport?: typeof fetch };
type Check = Parameters<typeof recheckFinanceAuthorization>[3][number];
const capture = (ctx: FinanceActorContext) => ({ ...ctx, authContext: restoreAuthorizationCap(captureAuthorizationCap(ctx.authContext)) });
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const normalizedHash = (parsed: ParsedBankStatement) => commandFingerprint(parsed.lines.map(row => ({ sourceOrder: row.sourceOrder, factHash: commandFingerprint(row.fact) })));
const checks = (organizationId: string, accountId: string, create: boolean): Check[] => {
  const resource = { type: "bank_statement", organizationId, id: accountId, financialRecordId: accountId, dataClass: "financial" as const };
  return [{ action: "view", resource, unconditional: true }, { action: "view", resource: { ...resource, type: "financial_transaction" }, unconditional: true },
    ...(create ? [{ action: "create" as const, resource, unconditional: true }] : [])];
};
async function authority(ctx: FinanceActorContext, tx: TenantTransaction, accountId: string, create: boolean) {
  await recheckFinanceAuthorization(ctx, tx, await new FinanceRepository(tx, ctx.organizationId).clock(), checks(ctx.organizationId, accountId, create), new BankStatementAccessError());
}
async function prepare(ctx: FinanceActorContext, raw: unknown, bytes: Uint8Array, tx: TenantTransaction, create: boolean) {
  const input = bankStatementReviewInput.parse(raw);
  await authority(ctx, tx, input.accountId, create);
  const repository = new BankStatementRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
  const account = await repository.account(input.accountId), now = await finance.clock();
  if (!account || account.archivedAt || account.teamWallet || account.accountType !== "ASSET_LOCATION" || account.normalSide !== "DEBIT") throw new BankStatementConfigurationError();
  const resolved = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: bankStatementPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
  if (!resolved) throw new BankStatementConfigurationError();
  const policy = { id: resolved.id, version: resolved.version, value: bankStatementPolicySchema.parse(resolved.value) };
  const binding = policy.value.accounts.find(binding => binding.account_code === account.code);
  if (!binding) throw new BankStatementConfigurationError();
  const currency = await new FinancialTransferRepository(tx, ctx.organizationId).currency(binding.currency);
  if (!currency || currency.minorUnit > 2) throw new BankStatementConfigurationError();
  if (input.fileSize !== bytes.byteLength || bytes.byteLength > policy.value.max_bytes || createHash("sha256").update(bytes).digest("hex") !== input.fileSha256) throw new BankStatementConflictError();
  let parsed: ParsedBankStatement;
  try {
    const decoded = new TextDecoder(policy.value.encoding, { fatal: true }).decode(bytes);
    if (decoded.includes("\u0000")) throw new BankStatementValidationError();
    parsed = parseBankStatementSource(decoded, input.format, policy.value, binding, currency.minorUnit);
  } catch (error) {
    if (error instanceof BankStatementConfigurationError || error instanceof BankStatementConflictError) throw error;
    throw new BankStatementValidationError();
  }
  const hash = normalizedHash(parsed);
  const identity = bankStatementBankIdentity(binding), drafts = parsed.lines.map(row => ({ identityHash: bankStatementLineIdentity(identity, input.fileSha256, row.sourceOrder, row.fact.externalId), factHash: commandFingerprint(row.fact) }));
  const existing = await repository.facts(drafts.map(row => row.identityHash)), expected = new Map(drafts.map(row => [row.identityHash, row.factHash]));
  if (existing.some(row => row.factHash !== expected.get(row.identityHash) || row.ledgerAccountId !== account.id || row.currency !== binding.currency)) throw new BankStatementConflictError();
  const fingerprint = commandFingerprint({ input, policy, account: { id: account.id, code: account.code, name: account.name }, minorUnit: currency.minorUnit, normalizedHash: hash, statement: parsed.statement });
  return { input, repository, account, binding, policy, parsed, normalizedHash: hash, fingerprint, reusedRows: existing.length, newRows: parsed.lines.length - existing.length };
}
function visible(ctx: FinanceActorContext, accountId: string, value: Record<string, unknown>) {
  return present({ ...ctx.authContext, visibleDataClasses: new Set(["financial"] as const) }, "view",
    { type: "bank_statement", organizationId: ctx.organizationId, id: accountId, financialRecordId: accountId, dataClass: "financial", data: value }, catalogFieldPolicy("bank_statement"));
}
export async function reviewBankStatement(context: FinanceActorContext, raw: unknown, bytes: Uint8Array, deps: Deps = {}) {
  const ctx = capture(context);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const prepared = await prepare(ctx, raw, bytes, tx, false);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_statement.reviewed", resourceType: "bank_statement", resourceId: prepared.account.id,
      after: { fileSha256: prepared.input.fileSha256, rowCount: prepared.parsed.lines.length, normalizedHash: prepared.normalizedHash }, reason: "Reviewed original bank source and explicit retained import mapping", requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await authority(ctx, tx, prepared.account.id, false);
    return visible(ctx, prepared.account.id, { reviewFingerprint: prepared.fingerprint, rowCount: prepared.parsed.lines.length, newRows: prepared.newRows, reusedRows: prepared.reusedRows,
      account: { id: prepared.account.id, name: prepared.account.name, code: prepared.account.code, lastFour: prepared.binding.account_id.slice(-4) },
      statement: prepared.parsed.statement, lines: prepared.parsed.lines.slice(0, 50) });
  });
}
async function store(bytes: Uint8Array, key: string, deps: Deps) {
  const storage = deps.storage ?? new R2StorageProvider(), transport = deps.transport ?? fetch;
  try {
    const signed = await storage.createSignedUploadUrl({ key, contentType: "application/octet-stream" });
    const response = await transport(signed.url, { method: "PUT", body: new Uint8Array(bytes), headers: { "Content-Type": "application/octet-stream", "If-None-Match": "*" }, signal: AbortSignal.timeout(15000) });
    if (!response.ok && response.status !== 412) throw new BankStatementStorageError();
    const read = await storage.createSignedDownloadUrl({ key, expiresInSeconds: 60 });
    const verified = await transport(read.url, { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!verified.ok || !verified.body) throw new BankStatementStorageError();
    const reader = verified.body.getReader(), hash = createHash("sha256"); let size = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > bytes.byteLength) throw new BankStatementStorageError(); hash.update(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    if (size !== bytes.byteLength || hash.digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new BankStatementStorageError();
  } catch { throw new BankStatementStorageError(); }
}
export async function importBankStatement(context: FinanceActorContext, raw: unknown, bytes: Uint8Array, deps: Deps = {}) {
  const ctx = capture(context), input = bankStatementImportInput.parse(raw), commandHash = commandFingerprint({ operation: "BANK_STATEMENT_IMPORT", input });
  const admitted = await withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new BankStatementRepository(tx, ctx.organizationId), locks = new FinancialTransferRepository(tx, ctx.organizationId);
    await locks.lock(`bank-statement-command:${ctx.actorId}:${input.idempotencyKey}`);
    const existing = await repository.admission(ctx.actorId, input.idempotencyKey);
    if (existing) { await authority(ctx, tx, existing.ledgerAccountId, !existing.import); if (existing.commandHash !== commandHash) throw new BankStatementConflictError(); return existing; }
    const { reviewFingerprint, idempotencyKey, reason, ...source } = input;
    await new ConfigRuleRepository(tx, ctx.organizationId).lockVersion(bankStatementPolicyKey, "organization", null);
    const prepared = await prepare(ctx, source, bytes, tx, true);
    if (prepared.fingerprint !== reviewFingerprint) throw new BankStatementConflictError();
    const id = randomUUID(), row = await repository.admit({ id, actorId: ctx.actorId, ledgerAccountId: input.accountId, idempotencyKey, commandHash,
      fileSha256: input.fileSha256, fileSize: input.fileSize, format: input.format, encoding: prepared.policy.value.encoding, policySnapshot: json({ ...prepared.policy, input }),
      bankIdentityHash: bankStatementBankIdentity(prepared.binding), storageKey: `${ctx.organizationId}/finance/bank-statements/${id}/${input.fileSha256}`, reason });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_statement.admitted", resourceType: "bank_statement", resourceId: row.id,
      after: { admissionId: row.id, idempotencyKey, commandHash, fileSha256: row.fileSha256, fileSize: row.fileSize, ledgerAccountId: row.ledgerAccountId, bankIdentityHash: row.bankIdentityHash }, reason, requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await repository.flush(); await authority(ctx, tx, row.ledgerAccountId, true);
    return { ...row, import: null };
  });
  if (admitted.import) return recoverBankStatement(ctx, { idempotencyKey: input.idempotencyKey }, deps);
  if (bytes.byteLength !== admitted.fileSize || createHash("sha256").update(bytes).digest("hex") !== admitted.fileSha256) throw new BankStatementConflictError();
  await store(bytes, admitted.storageKey, deps);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new BankStatementRepository(tx, ctx.organizationId), locks = new FinancialTransferRepository(tx, ctx.organizationId);
    await locks.lock(`bank-statement-command:${ctx.actorId}:${input.idempotencyKey}`);
    await locks.lock(`bank-statement-source:${admitted.bankIdentityHash}`);
    const original = await repository.admission(ctx.actorId, input.idempotencyKey);
    if (!original || original.commandHash !== commandHash) throw new BankStatementConflictError();
    if (original.import) { await authority(ctx, tx, original.ledgerAccountId, false); return visible(ctx, original.ledgerAccountId, { state: "IMPORTED", accountId: original.ledgerAccountId, admissionId: original.id, importId: original.import.id, rowCount: original.import.rowCount, newRows: original.import._count.originalLines, reusedRows: original.import.rowCount - original.import._count.originalLines }); }
    await new ConfigRuleRepository(tx, ctx.organizationId).lockVersion(bankStatementPolicyKey, "organization", null);
    const { reviewFingerprint, idempotencyKey, reason, ...source } = input; void idempotencyKey; void reason;
    const prepared = await prepare(ctx, source, bytes, tx, true);
    const retained = bankStatementPolicySnapshotSchema.parse(original.policySnapshot);
    if (prepared.fingerprint !== reviewFingerprint || commandFingerprint(prepared.policy) !== commandFingerprint({ id: retained.id, version: retained.version, value: retained.value })) throw new BankStatementConflictError();
    const imported = await repository.complete(original, prepared.parsed, prepared.binding.currency, prepared.normalizedHash);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_statement.imported", resourceType: "bank_statement", resourceId: imported.id,
      after: { importId: imported.id, admissionId: original.id, fileSha256: original.fileSha256, normalizedHash: imported.normalizedHash, rowCount: imported.rowCount, statement: imported.statement }, reason: original.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await repository.flush(); await authority(ctx, tx, original.ledgerAccountId, true);
    return visible(ctx, original.ledgerAccountId, { state: "IMPORTED", accountId: original.ledgerAccountId, admissionId: original.id, importId: imported.id, rowCount: imported.rowCount, newRows: imported.newRows, reusedRows: imported.reusedRows });
  });
}
export async function recoverBankStatement(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = capture(context), input = bankStatementRecoveryInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const row = await new BankStatementRepository(tx, ctx.organizationId).admission(ctx.actorId, input.idempotencyKey);
    if (!row) throw new BankStatementMissingError();
    await authority(ctx, tx, row.ledgerAccountId, false);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.bank_statement.recovered", resourceType: "bank_statement", resourceId: row.id,
      after: { admissionId: row.id, importId: row.import?.id ?? null }, reason: "Recovered original private bank import by its actor-bound nonce", requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    await authority(ctx, tx, row.ledgerAccountId, false);
    const retained = bankStatementPolicySnapshotSchema.parse(row.policySnapshot);
    return visible(ctx, row.ledgerAccountId, { state: row.import ? "IMPORTED" : "ADMITTED", accountId: row.ledgerAccountId, admissionId: row.id, importId: row.import?.id ?? null, rowCount: row.import?.rowCount ?? null,
      ...(row.import ? { newRows: row.import._count.originalLines, reusedRows: row.import.rowCount - row.import._count.originalLines } : retained.input ? { resumeInput: retained.input } : {}) });
  });
}
