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
