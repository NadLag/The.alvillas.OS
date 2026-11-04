import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { recheckFinancialRuleAccess } from "@/platform/config/financial-rule-authority";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { taxCategoryPolicySchema, taxHookContextPolicySchema } from "@/platform/config/tax-hook-policy";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { configSlugSchema } from "@/platform/config/identifiers";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { TaxHookRepository } from "../infrastructure/tax-hook-repository";
import { projectTaxPolicyHooks, taxHookInputSchema, TaxHookAccessError, TaxHookConfigurationError, TaxHookChangedError,
  type TaxHookContext } from "../domain/tax-hook";
import type { FinanceActorContext } from "./finance-access";

type Deps = { db: TenantTransactionRunner; requestId?: string };
async function authority(ctx: FinanceActorContext, tx: TenantTransaction) {
  await recheckFinancialRuleAccess(ctx, tx, "finance.tax", [{ action: "view", resource: { type: "config_rule", organizationId: ctx.organizationId, dataClass: "financial" }, organizationOnly: true }], new TaxHookAccessError());
}
async function resolve(ctx: FinanceActorContext, target: TaxHookContext, tx: TenantTransaction) {
  const at = new Date(target.occurredAt), resolver = new ReservationConfigScopeRepository(tx, ctx.organizationId);
  const groups = target.propertyId === null ? null : await resolver.propertyScopes([target.propertyId], at);
  const scopes = groups === null ? [{ scopeType: "organization", scopeId: null }] : groups.get(target.propertyId!);
  if (!scopes?.length) throw new TaxHookAccessError();
  const source = (await new ConfigRuleRepository(tx, ctx.organizationId).scopedSnapshot(scopes, at)).resolve("finance.tax");
  return { source, scopes, fingerprint: commandFingerprint({ scopes, source }) };
}

/** Read-only accounting interfaces: original policy values and exact native identity, with no assessed liability. */
export async function readTaxHooks(context: FinanceActorContext, raw: unknown, deps: Deps) {
  if (context.organizationId !== context.authContext.organizationId || context.actorId !== context.authContext.userAccountId) throw new TaxHookAccessError();
  const ctx = { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) }, target = taxHookInputSchema.parse(raw);
  return withTenant(deps.db, ctx.organizationId, async tx => {
    await authority(ctx, tx);
    const selected = await resolve(ctx, target, tx), source = selected.source;
    let result: ReturnType<typeof projectTaxPolicyHooks>;
    if (!source) result = projectTaxPolicyHooks(ctx.organizationId, null, target);
    else {
      const native = await new TaxHookRepository(tx, ctx.organizationId).models(source.id);
      const original = z.object({ taxes: z.array(z.unknown()) }).passthrough().safeParse(source.value);
      if (!original.success || commandFingerprint(original.data.taxes) !== commandFingerprint(native.rates.map(rate => rate.configuredValue))) throw new TaxHookConfigurationError();
      result = projectTaxPolicyHooks(ctx.organizationId, { ...source, organizationId: ctx.organizationId, value: { ...original.data, taxes: native.rates.map(rate => rate.configuredValue) } }, target);
      for (const rule of result.rules) {
        const row = native.rules.find(row => configSlugSchema.parse(row.taxKey) === rule.reference.taxKey && row.contextIndex === rule.reference.contextIndex && configSlugSchema.parse(row.categoryKey) === rule.categoryKey);
        const parsed = row ? taxHookContextPolicySchema.safeParse(row.context) : null;
        if (!parsed?.success || commandFingerprint(parsed.data) !== commandFingerprint(rule.context)) throw new TaxHookChangedError();
      }
      for (const category of result.categories) if (!native.categories.some(row => {
        const parsed = taxCategoryPolicySchema.safeParse({ key: row.key, labels: row.labels });
        return parsed.success && commandFingerprint(parsed.data) === commandFingerprint(category);
      })) throw new TaxHookChangedError();
    }
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.tax_hooks.read", resourceType: "tax_policy_hook",
      resourceId: source?.id ?? ctx.actorId, after: { key: "finance.tax", policyRuleId: source?.id ?? null, policyVersion: source?.version ?? null,
        context: target, status: result.status, matchedRules: result.rules.length }, requestId: deps.requestId ?? randomUUID(), occurredAt: await new FinanceRepository(tx, ctx.organizationId).clock() });
    if ((await resolve(ctx, target, tx)).fingerprint !== selected.fingerprint) throw new TaxHookChangedError();
    await authority(ctx, tx); return result;
  });
}
