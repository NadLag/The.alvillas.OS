import { z } from "zod";
import { taxRuleSchema } from "@/platform/config/rule-registry";
import { taxHookPolicySchema, type taxHookContextPolicySchema, type taxCategoryPolicySchema } from "@/platform/config/tax-hook-policy";
import { configSlugSchema } from "@/platform/config/identifiers";
import { commandFingerprint } from "@/platform/http/command-fingerprint";

const id = z.uuid().transform(value => value.toLowerCase()), at = z.iso.datetime({ offset: true });
const context = { occurredAt: at };
export const taxHookInputSchema = z.discriminatedUnion("kind", [
  z.object({ ...context, kind: z.literal("PROPERTY"), propertyId: id }).strict(),
  z.object({ ...context, kind: z.literal("SERVICE"), propertyId: id.nullable(), serviceKey: configSlugSchema }).strict(),
  z.object({ ...context, kind: z.literal("TRANSACTION"), propertyId: id.nullable(), transactionType: configSlugSchema }).strict()
]);
export type TaxHookContext = z.infer<typeof taxHookInputSchema>;
export type TaxPolicySource = { organizationId: string; id: string; key: string; version: number; scopeType: string; scopeId: string | null;
  lifecycle: string; effectiveFrom: Date; effectiveTo: Date | null; value: unknown };
export class TaxHookConfigurationError extends Error { constructor() { super("tax_hook_configuration_unavailable"); } }
export class TaxHookAccessError extends Error { constructor() { super("tax_hook_forbidden"); } }
export class TaxHookChangedError extends Error { constructor() { super("tax_hook_source_changed"); } }

export type TaxCategory = z.infer<typeof taxCategoryPolicySchema>;
/** Exact configured values retain the original policy; this profile never asserts an assessed liability. */
export type TaxRate = { key: string; amount: string | null; rateBps: number | null; currency: string | null;
  serviceAssessment: { basis: "ACTUAL_COLLECTED_GROSS"; method: "FIXED" | "BASIS_POINTS"; rounding: "HALF_UP_AT_LEDGER_PRECISION" } | null };
export type TaxRule = { reference: { policyRuleId: string; taxKey: string; contextIndex: number }; categoryKey: string; rateKey: string;
  context: z.infer<typeof taxHookContextPolicySchema> };

function applies(rule: TaxRule, target: TaxHookContext) {
  if (rule.context.kind !== target.kind) return false;
  const property = rule.context.properties;
  if (property.mode === "COMPANY" ? target.propertyId !== null : property.mode === "SELECTED" && (target.propertyId === null || !property.ids.includes(target.propertyId))) return false;
  if (rule.context.kind === "SERVICE" && target.kind === "SERVICE") return rule.context.services.mode === "ANY" || rule.context.services.keys.includes(target.serviceKey);
  if (rule.context.kind === "TRANSACTION" && target.kind === "TRANSACTION") return rule.context.transactionTypes.mode === "ANY" || rule.context.transactionTypes.keys.includes(target.transactionType);
  return true;
}

/** ConfigRule remains the only versioned rule engine; these are typed native read models. */
export function projectTaxPolicyHooks(organizationId: string, source: TaxPolicySource | null, raw: unknown) {
  const target = taxHookInputSchema.parse(raw); id.parse(organizationId);
  if (!source) return { status: "NO_POLICY" as const, source: null, context: target, categories: [] as TaxCategory[], rates: [] as TaxRate[], rules: [] as TaxRule[], deferredTaxKeys: [] as string[], assessedLiability: null };
  const instant = new Date(target.occurredAt);
  if (source.organizationId !== organizationId || source.key !== "finance.tax" || !id.safeParse(source.id).success || !Number.isSafeInteger(source.version) || source.version < 1 ||
      !["ACTIVE", "RETIRED"].includes(source.lifecycle) || !Number.isFinite(source.effectiveFrom.getTime()) || source.effectiveFrom > instant ||
      source.effectiveTo !== null && (!Number.isFinite(source.effectiveTo.getTime()) || instant >= source.effectiveTo) ||
      source.scopeType === "property" && source.scopeId !== target.propertyId) throw new TaxHookConfigurationError();
  const parsed = taxRuleSchema.safeParse(source.value); if (!parsed.success) throw new TaxHookConfigurationError();
  const config = parsed.data, categories = new Map<string, TaxCategory>(), rates: TaxRate[] = [], rules: TaxRule[] = [], deferredTaxKeys: string[] = [], seen = new Set<string>();
  for (const tax of config.taxes) {
    if (seen.has(tax.key)) throw new TaxHookConfigurationError(); seen.add(tax.key);
    const metadata: unknown = tax.tax_hook;
    if (metadata === undefined) { deferredTaxKeys.push(tax.key); continue; }
    const metadataResult = taxHookPolicySchema.safeParse(metadata); if (!metadataResult.success) throw new TaxHookConfigurationError();
    const hook = metadataResult.data, previous = categories.get(hook.category.key);
    if (previous && commandFingerprint(previous) !== commandFingerprint(hook.category)) throw new TaxHookConfigurationError();
    categories.set(hook.category.key, hook.category);
    rates.push({ key: tax.key, amount: tax.amount ?? null, rateBps: tax.rate_bps ?? null, currency: tax.currency ?? null, serviceAssessment: tax.service_assessment ?? null });
    hook.contexts.forEach((scope, contextIndex) => rules.push({ reference: { policyRuleId: source.id.toLowerCase(), taxKey: tax.key, contextIndex }, categoryKey: hook.category.key, rateKey: tax.key, context: scope }));
  }
  const matches = rules.filter(rule => applies(rule, target)), selectedRates = new Set(matches.map(rule => rule.rateKey)), selectedCategories = new Set(matches.map(rule => rule.categoryKey));
  if (selectedRates.size !== matches.length) throw new TaxHookConfigurationError();
  return { status: matches.length ? "MATCHED" as const : rules.length ? "NO_MATCH" as const : "DEFERRED" as const,
    source: { id: source.id.toLowerCase(), key: "finance.tax" as const, version: source.version, effectiveFrom: source.effectiveFrom.toISOString(), effectiveTo: source.effectiveTo?.toISOString() ?? null },
    context: target, categories: [...categories.values()].filter(category => selectedCategories.has(category.key)), rates: rates.filter(rate => selectedRates.has(rate.key)), rules: matches,
    deferredTaxKeys, assessedLiability: null };
}
