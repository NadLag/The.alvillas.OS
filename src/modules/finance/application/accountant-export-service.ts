import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { accountantExportAuthorityChecks } from "@/platform/authz/accountant-export-resource";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { consumeRateLimit } from "@/platform/rate-limit/postgres-rate-limiter";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { AccountantPostingExportRepository } from "../infrastructure/accountant-posting-export-repository";
import { accountantExportPolicyKey, accountantExportPolicySchema } from "../domain/accountant-export-policy";
import { accountantExportInputSchema, accountantExportRow, validateAccountantExportDocument, AccountantExportAccessError, AccountantExportChangedError, AccountantExportSourceError,
  AccountantExportConfigurationError, AccountantExportRateLimitError, type AccountantExportColumn, type AccountantExportDocument, type AccountantExportNativeSnapshot } from "../domain/accountant-export";
import { captureAccountantOwnerSource } from "./accountant-owner-export-source";
import { captureAccountantBankSource, accountantBankExportAccounts } from "./accountant-bank-export-source";
import { accountantEditorInputSchema, accountantEditorSchema } from "../domain/accountant-export-editor";
import { captureAccountantPaymentSource } from "./accountant-payment-export-source";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db: TenantTransactionRunner; requestId?: string };
const columns: AccountantExportColumn[] = ["recordType", "sourceId", "transactionId", "postingId", "reference", "occurredAt", "description", "currency", "accountId", "accountCode", "accountType", "normalSide", "side", "amount", "bucket", "propertyId", "ownerId", "supplierId", "invoiceId", "personId", "claimId", "reversesTransactionId"];
async function authority(ctx: FinanceActorContext, tx: TenantTransaction) {
  const now = await new FinanceRepository(tx, ctx.organizationId).clock();
  await recheckAccountAuthorization(ctx, tx, now, accountantExportAuthorityChecks(ctx.organizationId), new AccountantExportAccessError()); return now;
}
async function context(ctx: FinanceActorContext, tx: TenantTransaction, currency: string) {
  const now = await authority(ctx, tx), repository = new AccountantPostingExportRepository(tx, ctx.organizationId);
  const rule = await new ConfigRuleRepository(tx, ctx.organizationId).resolve({ key: accountantExportPolicyKey, scopes: [{ scopeType: "organization", scopeId: null }], asOf: now });
  if (!rule) throw new AccountantExportConfigurationError(); const parsed = accountantExportPolicySchema.safeParse(rule.value);
  if (!parsed.success) throw new AccountantExportConfigurationError();
  const settings = await repository.settings(); if (!settings.timezone) throw new AccountantExportConfigurationError();
  return { now, rule, policy: parsed.data, settings, repository, identity: commandFingerprint({ rule, timezone: settings.timezone, currency: settings.currencies.find(row => row.code === currency) ?? null }) };
}

/** A format renderer runs inside the final source fence; no attachment can escape an uncommitted audit or a changed source. */
export async function prepareAccountantExport<T>(contextInput: FinanceActorContext, raw: unknown,
  render: (document: AccountantExportDocument, maxRows: number) => T | Promise<T>, deps: Deps): Promise<T> {
  if (contextInput.organizationId !== contextInput.authContext.organizationId || contextInput.actorId !== contextInput.authContext.userAccountId) throw new AccountantExportAccessError();
  const ctx = { ...contextInput, authContext: restoreAuthorizationCap(captureAuthorizationCap(contextInput.authContext)) }, input = accountantExportInputSchema.parse(raw);
  const admission = await withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await context(ctx, tx, input.currency);
    if (!current.policy.reports.includes(input.kind) || !current.policy.formats.includes(input.format)) throw new AccountantExportConfigurationError();
    const decision = await consumeRateLimit(tx, ctx.organizationId, { key: "finance.accountant_exports:" + ctx.actorId, limit: current.policy.rate_limit.requests,
      windowSeconds: current.policy.rate_limit.window_seconds, now: current.now }); return { identity: current.identity, decision };
  });
  if (!admission.decision.allowed) throw new AccountantExportRateLimitError(admission.decision.resetAt);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await context(ctx, tx, input.currency); if (current.identity !== admission.identity) throw new AccountantExportChangedError();
    if (!current.settings.currencies.some(row => row.code === input.currency)) throw new AccountantExportSourceError();
    if (input.propertyId && !await current.repository.property(input.propertyId)) throw new AccountantExportAccessError();
    const classification = input.kind === "INCOME" ? current.policy.classifications.income : input.kind === "EXPENSES" ? current.policy.classifications.expenses : undefined;
    if ((input.kind === "INCOME" || input.kind === "EXPENSES") && !classification) throw new AccountantExportConfigurationError();
    if (classification?.account_codes) {
      const actual = await current.repository.accountCodes(classification.account_codes);
      if (actual.length !== classification.account_codes.length || actual.some(row => !classification.account_types.includes(row.accountType as "ALVILLAS_OWN" | "CLAIM_OWNERSHIP"))) throw new AccountantExportConfigurationError();
    }
    const maxRows = current.policy.capacity[input.format], scope = { currency: input.currency, propertyId: input.propertyId,
      ...await current.repository.range(input.fromOn, input.toOn, current.settings.timezone!), maxRows, classification };
    const readNative = async (): Promise<AccountantExportNativeSnapshot> => {
      if (input.kind === "OWNER_STATEMENTS") return captureAccountantOwnerSource(tx, ctx.organizationId, input, scope);
      if (input.kind === "BANK_RECONCILIATION") return captureAccountantBankSource(tx, ctx.organizationId, input, scope, maxRows);
      if (input.kind === "SUPPLIER_PAYMENTS" || input.kind === "STAFF_PAYMENTS") return captureAccountantPaymentSource(tx, ctx.organizationId, input, scope);
      const source = await current.repository.postings(scope), rows = source.map(row => {
        const { sourceValid, ...facts } = row;
        if (!sourceValid || row.currency !== input.currency || !["DEBIT", "CREDIT"].includes(row.side) || !["DEBIT", "CREDIT"].includes(row.normalSide)) throw new AccountantExportSourceError();
        return accountantExportRow(row.id, columns, { ...facts, amount: Money.of(row.amount, row.currency).toJSON().amount, recordType: "POSTING", sourceId: row.id, postingId: row.id });
      }); return { columns, rows, fingerprint: commandFingerprint({ scope, source }) };
    };
    const capture = async () => { try { return await readNative(); } catch (error) { if (error instanceof ZodError) throw new AccountantExportSourceError(); throw error; } };
    const native = await capture(), sourceFingerprint = native.fingerprint, rows = native.rows;
    const document = validateAccountantExportDocument({ organizationId: ctx.organizationId, kind: input.kind, currency: input.currency, fromOn: input.fromOn, toOn: input.toOn,
      scope: { propertyId: input.propertyId ?? null, ownerId: input.ownerId ?? null, accountId: input.accountId ?? null },
      timezone: current.settings.timezone, policy: { id: current.rule.id, version: current.rule.version }, generatedAt: current.now.toISOString(), sourceFingerprint, columns: native.columns, rows }, maxRows);
    const file = await render(document, maxRows);
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.accountant_export.generated", resourceType: "accountant_export", resourceId: current.rule.id,
      propertyScopeId: input.propertyId, after: { kind: input.kind, format: input.format, locale: input.locale, fromOn: input.fromOn, toOn: input.toOn, currency: input.currency,
        timezone: document.timezone, policyId: current.rule.id, policyVersion: current.rule.version, sourceFingerprint, rowCount: rows.length }, reason: input.reason,
      requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
    if ((await context(ctx, tx, input.currency)).identity !== current.identity || (await capture()).fingerprint !== sourceFingerprint) throw new AccountantExportChangedError();
    await authority(ctx, tx); return file;
  });
}

/** Private, bounded native choices use the same independent held/current source grants as the generated attachments. */
export async function readAccountantExportEditor(contextInput: FinanceActorContext, raw: unknown, deps: Deps) {
  if (contextInput.organizationId !== contextInput.authContext.organizationId || contextInput.actorId !== contextInput.authContext.userAccountId) throw new AccountantExportAccessError();
  const ctx = { ...contextInput, authContext: restoreAuthorizationCap(captureAuthorizationCap(contextInput.authContext)) }, input = accountantEditorInputSchema.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    const current = await context(ctx, tx, input.currency ?? ""), currency = input.currency ?? current.settings.baseCurrency;
    if (!current.settings.currencies.some(row => row.code === currency)) throw new AccountantExportSourceError();
    const choices = !input.choice ? [] : input.choice === "bank"
      ? (await accountantBankExportAccounts(tx, ctx.organizationId, currency)).accounts.filter(row => (!input.after || row.id > input.after) && (row.code + " " + row.name).toLocaleLowerCase().includes(input.query.toLocaleLowerCase())).slice(0, 31).map(row => ({ id: row.id, label: row.code + " · " + row.name }))
      : await current.repository.choices(input.choice, input.query, input.after);
    const result = accountantEditorSchema.parse({ reports: current.policy.reports, formats: current.policy.formats, currency, currencies: current.settings.currencies.map(row => row.code),
      timezone: current.settings.timezone, ...await current.repository.defaults(current.now, current.settings.timezone!), choices: choices.slice(0, 30), next: choices.length > 30 ? choices[29].id : null,
      arabicPdfAvailable: Boolean(process.env.PDF_RENDERER_ENDPOINT && process.env.PDF_RENDERER_TOKEN) });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.accountant_export.editor_read", resourceType: "accountant_export", resourceId: current.rule.id,
      after: { choice: input.choice ?? null, count: result.choices.length, currency, policyId: current.rule.id }, requestId: deps.requestId ?? randomUUID(), occurredAt: current.now });
    if ((await context(ctx, tx, input.currency ?? "")).identity !== current.identity) throw new AccountantExportChangedError();
    await authority(ctx, tx); return result;
  });
}
