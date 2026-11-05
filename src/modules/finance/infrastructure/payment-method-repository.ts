import type { TenantTransaction } from "@/platform/db/tenant";
import { ConfigRuleRepository, type ConfigScopeCandidate } from "@/platform/config/config-rule-repository";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { FinancialTransferRepository } from "./financial-transfer-repository";
import { paymentMethodPolicyKey, paymentMethodPolicySchema, PaymentMethodConfigurationError } from "../domain/payment-method";

/** Configured lookup definitions reuse native rule versions and the existing exact-money currency catalog. */
export class PaymentMethodRepository {
  constructor(private readonly tx: TenantTransaction, private readonly organizationId: string) {}
  acceptance(namespace: string, source: string) {
    return this.tx.auditLog.findFirst({ where: { organizationId: this.organizationId, action: "finance.payment_method.accepted", resourceType: "financial_transaction",
      AND: [{ after: { path: ["sourceNamespace"], equals: namespace } }, { after: { path: ["source"], equals: source } }] }, orderBy: { createdAt: "asc" } });
  }
  async catalog(input: { at: Date; currency?: string; scopes: ConfigScopeCandidate[] }) {
    const catalog = await this.optionalCatalog(input);
    if (!catalog) throw new PaymentMethodConfigurationError();
    return catalog;
  }
  async retainedCatalog(input: { ruleId: string; version: number; identity: string; currency: string }) {
    const rule = await new ConfigRuleRepository(this.tx, this.organizationId).findById(input.ruleId);
    if (!rule || rule.key !== paymentMethodPolicyKey || rule.version !== input.version || !/^[a-f0-9]{64}$/u.test(input.identity)) throw new PaymentMethodConfigurationError();
    const policy = paymentMethodPolicySchema.parse(rule.value), references = await new FinancialTransferRepository(this.tx, this.organizationId).currencyChoices();
    if (!references.currencies.some(row => row.code === input.currency)) throw new PaymentMethodConfigurationError();
    return { rule: { ...rule, parsedValue: policy }, policy, currency: input.currency, currencies: references.currencies, identity: input.identity,
      methods: policy.methods.filter(method => method.enabled && method.currencies.includes(input.currency)) };
  }
  async optionalCatalog(input: { at: Date; currency?: string; scopes: ConfigScopeCandidate[] }) {
    const rule = await new ConfigRuleRepository(this.tx, this.organizationId).resolve({ key: paymentMethodPolicyKey, scopes: input.scopes, asOf: input.at });
    if (!rule) return null; const parsed = paymentMethodPolicySchema.safeParse(rule.value);
    if (!parsed.success) throw new PaymentMethodConfigurationError();
    const references = await new FinancialTransferRepository(this.tx, this.organizationId).currencyChoices(), currency = input.currency ?? references.baseCurrency;
    const available = new Set(references.currencies.map(row => row.code));
    if (!available.has(currency) || parsed.data.methods.some(method => method.currencies.some(code => !available.has(code)))) throw new PaymentMethodConfigurationError();
    return { rule, policy: parsed.data, currency, currencies: references.currencies, identity: commandFingerprint({ rule, references }),
      methods: parsed.data.methods.filter(method => method.enabled && method.currencies.includes(currency)) };
  }
}
