import { randomUUID } from "node:crypto";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { calendarDateAt } from "@/i18n/format";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { AccountingPeriodRepository } from "../infrastructure/accounting-period-repository";
import { LedgerIntegrityRepository } from "../infrastructure/ledger-integrity-repository";
import { ledgerIntegrityPolicyKey, ledgerIntegrityPolicySchema, LedgerIntegrityRebuild } from "../domain/ledger-integrity";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class LedgerIntegrityAccessError extends Error {}
export class LedgerIntegrityConfigurationError extends Error {}
export class LedgerIntegritySourceChangedError extends Error {}
const localTime = (at: Date, timezone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);

async function settings(organizationId: string, tx: TenantTransaction) {
  const now = await new FinanceRepository(tx, organizationId).clock(), rule = await new ConfigRuleRepository(tx, organizationId).resolve({ key: ledgerIntegrityPolicyKey,
    scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
  if (!rule) return null;
  const policy = ledgerIntegrityPolicySchema.safeParse(rule.value), calendar = await new AccountingPeriodRepository(tx, organizationId).policy(now);
  if (!policy.success || !rule.createdBy || !calendar) throw new LedgerIntegrityConfigurationError();
  requireCurrentTimezoneData();
  return { rule, policy: policy.data, now, timezone: calendar.value.timezone,
    identity: commandFingerprint({ ruleId: rule.id, value: rule.value, reason: rule.reason, actorId: rule.createdBy, calendarId: calendar.id, calendarValue: calendar.value }) };
}
async function authority(ctx: FinanceActorContext, tx: TenantTransaction) {
  const now = await new FinanceRepository(tx, ctx.organizationId).clock();
  await recheckAccountAuthorization(ctx, tx, now, [{ action: "configure", resource: { type: "config_rule", organizationId: ctx.organizationId, dataClass: "financial" }, organizationOnly: true },
    ...financialRuleSourceChecks(ctx.organizationId, ledgerIntegrityPolicyKey)], new LedgerIntegrityAccessError());
}

/** Called by the signed dispatcher only after failure routing is wired. Every
 * occurrence has a configured local time and an immutable native receipt. */
export async function scheduleLedgerIntegrity(organizationId: string, deps: Deps = {}) {
  const db = deps.db ?? prisma, admission = await withTenant(db, organizationId, async tx => {
    const configured = await settings(organizationId, tx); if (!configured) return null;
    const actorId = configured.rule.createdBy!, authContext = restoreAuthorizationCap(captureAuthorizationCap(await authContextForAccountInTransaction(tx, organizationId, actorId))),
      ctx = { organizationId, actorId, authContext };
    await authority(ctx, tx);
    const on = calendarDateAt(configured.now, configured.timezone), completed = await new LedgerIntegrityRepository(tx, organizationId).completed(configured.rule.id, on);
    return { ...configured, ctx, on, completed, due: localTime(configured.now, configured.timezone) >= configured.policy.run_at };
  });
  if (!admission) return { configured: false, runId: null, passed: null };
  if (admission.completed) return { configured: true, runId: admission.completed.id, passed: admission.completed.passed };
  if (!admission.due) return { configured: true, runId: null, passed: null };
  const captured = await withTenant(db, organizationId, async tx => {
    const configured = await settings(organizationId, tx); if (!configured || configured.identity !== admission.identity) throw new LedgerIntegritySourceChangedError();
    await authority(admission.ctx, tx);
    const repository = new LedgerIntegrityRepository(tx, organizationId), rebuild = new LedgerIntegrityRebuild(admission.policy), pageSize = admission.policy.page_size;
    let after: string | undefined;
    for (;;) {
      const rows = await repository.movements(after, pageSize); for (const row of rows) rebuild.add(row);
      if (rows.length < pageSize) break; after = rows.at(-1)!.id;
    }
    rebuild.compareAccounts(await repository.accounts()); rebuild.compareTransactions(await repository.transactions());
    if (!await repository.guardState()) rebuild.finding("RETAINED_HISTORY", null, null);
    for (const row of await repository.retainedDifferences()) rebuild.finding("RETAINED_HISTORY", row.id, null);
    for (const row of await repository.closedPeriodDifferences()) rebuild.finding("CLOSED_PERIOD", row.id, null);
    const sources: { id: string; fingerprint: string }[] = []; after = undefined;
    for (;;) {
      const rows = await repository.fingerprints(after, pageSize); sources.push(...rows);
      if (rows.length < pageSize) break; after = rows.at(-1)!.id;
    }
    return { report: rebuild.finish(), sources, checkedAt: configured.now };
  }, { isolationLevel: "RepeatableRead" });
  // The final transaction sees current stored grants after the coherent source
  // snapshot has ended, and rechecks the original journals before publication.
  return withTenant(db, organizationId, async tx => {
    const repository = new LedgerIntegrityRepository(tx, organizationId), rules = new ConfigRuleRepository(tx, organizationId);
    await rules.lockVersion(ledgerIntegrityPolicyKey, "organization", null); await repository.lock();
    const configured = await settings(organizationId, tx); if (!configured || configured.identity !== admission.identity) throw new LedgerIntegritySourceChangedError();
    await authority(admission.ctx, tx);
    const completed = await repository.completed(admission.rule.id, admission.on);
    if (completed) return { configured: true, runId: completed.id, passed: completed.passed };
    const pageSize = admission.policy.page_size;
    for (let offset = 0; offset < captured.sources.length; offset += pageSize) if (!await repository.snapshotMatches(captured.sources.slice(offset, offset + pageSize))) throw new LedgerIntegritySourceChangedError();
    let baselines = 0;
    if (captured.report.passed) for (let offset = 0; offset < captured.sources.length; offset += pageSize) baselines += await repository.preserveSources(captured.sources.slice(offset, offset + pageSize));
    const row = await repository.record({ on: admission.on, policyRuleId: admission.rule.id, createdBy: admission.ctx.actorId,
      checkedAt: captured.checkedAt, passed: captured.report.passed, report: captured.report });
    await writeAuditEvent(tx, { organizationId, actorId: admission.ctx.actorId, action: captured.report.passed ? "finance.ledger_integrity.passed" : "finance.ledger_integrity.failed",
      resourceType: "config_rule", resourceId: admission.rule.id, after: { key: ledgerIntegrityPolicyKey, runId: row.id, on: admission.on,
        checkedAt: captured.checkedAt.toISOString(), passed: row.passed, movements: captured.report.movements, failureCount: captured.report.failureCount, baselines },
      reason: admission.rule.reason, requestId: deps.requestId ?? randomUUID(), occurredAt: configured.now });
    await authority(admission.ctx, tx);
    return { configured: true, runId: row.id, passed: row.passed };
  });
}
