import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { present, catalogFieldPolicy } from "@/platform/authz/present";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { companyLedgerFilters, companyLedgerTotals, canViewCompleteCompanyLedger } from "../domain/company-ledger";
import { CompanyLedgerRepository } from "../infrastructure/company-ledger-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class CompanyLedgerAccessError extends Error {}
export class CompanyLedgerConfigurationError extends Error {}
const target = (organizationId: string) => ({ type: "company_ledger", organizationId, dataClass: "financial" as const });

async function authority(ctx: FinanceActorContext, tx: TenantTransaction) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new CompanyLedgerAccessError();
  const now = await new FinanceRepository(tx, ctx.organizationId).clock();
  const current = await authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
  if (![ctx.authContext, current].every(auth => auth.permissions.has("company_ledger:view") && canViewCompleteCompanyLedger(auth, target(ctx.organizationId), now))) throw new CompanyLedgerAccessError();
  return now;
}

export async function assertCompanyLedgerAccess(ctx: FinanceActorContext, deps: Deps = {}) {
  await withTenant(deps.db ?? prisma, ctx.organizationId, tx => authority(ctx, tx));
}

export async function getCompanyLedger(ctx: FinanceActorContext, raw: unknown = {}, deps: Deps = {}) {
  const input = companyLedgerFilters.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const now = await authority(ctx, tx), repository = new CompanyLedgerRepository(tx, ctx.organizationId);
    const settings = await repository.settings(), policy = input.timezone ? null : await new AccountingPeriodRepository(tx, ctx.organizationId).policy(now);
    const timezone = input.timezone ?? policy?.value.timezone ?? settings.timezone, currency = input.currency ?? settings.baseCurrency;
    if (!timezone || !settings.currencies.some(row => row.code === currency)) throw new CompanyLedgerConfigurationError();
    const defaults = await repository.defaults(now, timezone), fromOn = input.fromOn ?? defaults.fromOn, toOn = input.toOn ?? defaults.toOn;
    if (fromOn > toOn) throw new CompanyLedgerConfigurationError();
    const scope = { ...await repository.range(fromOn, toOn, timezone), currency };
    const totals = companyLedgerTotals(await repository.totals(scope), currency);
    const page = await repository.page({ ...scope, openingBalance: totals.openingBalance, after: input.after });
    if (!page.cursorFound) throw new CompanyLedgerAccessError();
    const data = { ...totals, lines: page.lines.slice(0, 50) };
    const visible = present({ ...ctx.authContext, visibleDataClasses: new Set() }, "view", { ...target(ctx.organizationId), data }, catalogFieldPolicy<typeof data>("company_ledger"), now) as typeof data;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.company_ledger.viewed", resourceType: "company_ledger", resourceId: ctx.organizationId,
      after: { fromOn, toOn, currency, timezone, rowCount: visible.lines.length }, reason: "Viewed the derived ALVILLAS company ledger",
      requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { ...visible, fromOn, toOn, currency, timezone, currencies: settings.currencies, snapshotAt: now.toISOString(), next: page.lines.length > 50 ? page.lines[49].id : undefined };
  }, { isolationLevel: "RepeatableRead" });
}
