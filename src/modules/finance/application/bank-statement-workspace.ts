import { randomUUID } from "node:crypto";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner, type TenantTransaction } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { authorizeUnconditionalSource } from "@/platform/authz/organization-authority";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicyKey, bankStatementPolicySchema, type BankStatementPolicy } from "@/platform/config/bank-statement-policy";
import { bankStatementWorkspaceInput, bankStatementAccountSchema, bankStatementAccountsSchema, bankStatementListSchema, bankStatementDetailSchema, bankStatementImportSummarySchema } from "../domain/bank-statement-workspace";
import { bankStatementBankIdentity, bankStatementFactSchema, BankStatementAccessError, BankStatementConfigurationError } from "../domain/bank-statement-import";
import { BankStatementRepository } from "../infrastructure/bank-statement-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization, type FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
type Check = Parameters<typeof recheckFinanceAuthorization>[3][number];
const accountChecks = (ctx: FinanceActorContext, id: string): Check[] => ["bank_statement", "financial_transaction"].map(type => ({ action: "view", resource: { type, organizationId: ctx.organizationId, id, financialRecordId: id, dataClass: "financial" }, unconditional: true }));
async function configuration(ctx: FinanceActorContext, tx: TenantTransaction) {
  const row = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: bankStatementPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: await new FinanceRepository(tx, ctx.organizationId).clock() });
  if (!row) return null;
  const parsed = bankStatementPolicySchema.safeParse(row.value); return parsed.success ? parsed.data : null;
}
function summary(row: NonNullable<Awaited<ReturnType<BankStatementRepository["imported"]>>>) {
  return bankStatementImportSummarySchema.parse({ id: row.id, admissionId: row.admissionId, accountId: row.admission.ledgerAccountId, format: row.admission.format,
    fileSha256: row.admission.fileSha256, fileSize: row.admission.fileSize, rowCount: row.rowCount, newRows: row._count.originalLines, reusedRows: row.rowCount - row._count.originalLines, importedAt: row.createdAt.toISOString(), reason: row.admission.reason });
}
function accountView(account: { id: string; code: string; name: string }, binding: BankStatementPolicy["accounts"][number], canImport: boolean, maxBytes: number) {
  return bankStatementAccountSchema.parse({ id: account.id, code: account.code, name: account.name, currency: binding.currency, lastFour: binding.account_id.slice(-4),
    formats: [...binding.csv ? ["CSV"] : [], ...binding.ofx ? ["OFX"] : []], maxBytes, canImport });
}
export async function readBankStatementWorkspace(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const ctx = { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) }, input = bankStatementWorkspaceInput.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new BankStatementRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId), now = await finance.clock();
    const current = { ...await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId), personId: ctx.authContext.personId };
    const allows = (checks: Check[]) => checks.every(check => [ctx.authContext, current].every(auth => authorizeUnconditionalSource(auth, check.action, check.resource, now)));
    const complete: Check[] = [];
    const disclose = async <T extends Record<string, unknown>>(value: T, resourceId: string, action: string) => {
      await recheckFinanceAuthorization(ctx, tx, await finance.clock(), complete, new BankStatementAccessError());
      await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action, resourceType: "bank_statement", resourceId,
        after: { operation: input.operation }, reason: "Viewed independently authorized original bank statement evidence", requestId: deps.requestId ?? randomUUID(), occurredAt: await finance.clock() });
      await recheckFinanceAuthorization(ctx, tx, await finance.clock(), complete, new BankStatementAccessError());
      const target = complete.find(check => check.resource.type === "bank_statement")?.resource;
      if (!target && input.operation !== "ACCOUNTS") throw new BankStatementAccessError();
      return target ? present({ ...ctx.authContext, visibleDataClasses: new Set(["financial"] as const) }, "view", { ...target, data: value }, catalogFieldPolicy("bank_statement")) : value;
    };
    if (input.operation === "ACCOUNTS") {
      if ([ctx.authContext, current].some(auth => !auth.permissions.has("bank_statement:view") || !auth.permissions.has("financial_transaction:view"))) throw new BankStatementAccessError();
      const policy = await configuration(ctx, tx), historical = await repository.historyAccounts(), rows = await repository.accounts(policy?.accounts.map(account => account.account_code) ?? []), items = [];
      if (!policy && !historical.length) throw new BankStatementConfigurationError();
      const accountIds = new Set(rows.map(row => row.id));
      for (const row of rows) {
        const checks = accountChecks(ctx, row.id); if (!allows(checks)) continue; complete.push(...checks);
        const binding = policy!.accounts.find(binding => binding.account_code === row.code)!;
        items.push(accountView(row, binding, allows([{ action: "create", resource: { ...checks[0].resource }, unconditional: true }]), policy!.max_bytes));
      }
      for (const source of historical) {
        if (accountIds.has(source.ledgerAccountId)) continue;
        const checks = accountChecks(ctx, source.ledgerAccountId); if (!allows(checks)) continue; complete.push(...checks);
        const retained = bankStatementPolicySchema.parse((source.policySnapshot as { value: unknown }).value), binding = retained.accounts.find(binding => bankStatementBankIdentity(binding) === source.bankIdentityHash);
        if (!binding) throw new BankStatementAccessError();
        items.push(accountView(source.ledgerAccount, binding, false, retained.max_bytes));
      }
      return disclose(bankStatementAccountsSchema.parse({ items }), ctx.organizationId, "finance.bank_statement.accounts_viewed");
    }
    if (input.operation === "LIST") {
      complete.push(...accountChecks(ctx, input.accountId)); await recheckFinanceAuthorization(ctx, tx, now, complete, new BankStatementAccessError());
      const rows = await repository.list(input.accountId, input.before);
      return disclose(bankStatementListSchema.parse({ items: rows.slice(0, 50).map(summary), next: rows.length > 50 ? rows[49].id : null }), input.accountId, "finance.bank_statement.list_viewed");
    }
    const imported = await repository.imported(input.importId);
    if (!imported) throw new BankStatementAccessError();
    complete.push(...accountChecks(ctx, imported.admission.ledgerAccountId)); await recheckFinanceAuthorization(ctx, tx, now, complete, new BankStatementAccessError());
    const account = await repository.account(imported.admission.ledgerAccountId);
    const retained = bankStatementPolicySchema.parse((imported.admission.policySnapshot as { value: unknown }).value);
    const binding = retained.accounts.find(binding => bankStatementBankIdentity(binding) === imported.admission.bankIdentityHash);
    if (!account || !binding) throw new BankStatementAccessError();
    const rows = await repository.evidence(imported.id, input.afterOrder);
    return disclose(bankStatementDetailSchema.parse({ source: summary(imported), account: accountView(account, binding, false, retained.max_bytes),
      lines: rows.slice(0, 50).map(row => ({ id: row.line.id, sourceOrder: row.sourceOrder, fact: bankStatementFactSchema.parse(row.line.source) })), nextOrder: rows.length > 50 ? rows[49].sourceOrder : null }), imported.id, "finance.bank_statement.detail_viewed");
  });
}
