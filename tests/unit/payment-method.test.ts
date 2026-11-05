import { describe, expect, it } from "vitest";
import { Money } from "@/platform/money/money";
import { configuredPaymentMethod, paymentMethodPolicySchema, PaymentMethodConfigurationError } from "@/modules/finance/domain/payment-method";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";

const method = () => ({ key: "local-bank-transfer", labels: { en: "Configured bank transfer", fr: "Virement configuré", ar: "تحويل بنكي مهيأ" },
  enabled: true, adapter: "bank_transfer", currencies: ["MAD", "EUR"] });
describe("configured original payment methods", () => {
  it("uses the existing versioned rule registry and independently protects actual funding source groups", () => {
    const policy = { methods: [method()] }; expect(parseConfigRuleValue("finance.payment_methods", policy)).toEqual(policy);
    expect(financialRuleSourceChecks("fixture-org", "finance.payment_methods").map(check => check.resource.type).sort()).toEqual(["bank_statement", "cash_collection", "financial_transaction"]);
  });
  it.each(["cash", "bank_transfer", "airbnb_settlement", "manual", "paypal"] as const)("admits the configured %s protocol with exact selected currency", adapter => {
    const selected = { ...method(), key: "actual." + adapter, adapter }, policy = { methods: [selected] }, before = structuredClone(policy);
    expect(configuredPaymentMethod(policy, selected.key, Money.of("9007199254740993.07", "EUR"))).toEqual(selected); expect(policy).toEqual(before);
  });
  it("retains independent custom method identities for the same technical adapter", () => {
    const first = method(), second = { ...method(), key: "second-bank", labels: { en: "Second bank", fr: "Autre banque", ar: "بنك آخر" } }, policy = { methods: [first, second] };
    expect(configuredPaymentMethod(policy, second.key, Money.of("0.07", "MAD"))).toEqual(second);
  });
  it.each(["unknown", "LOCAL-BANK-TRANSFER", ""])("denies an unknown method identity without a fallback %#", identity => {
    expect(() => configuredPaymentMethod({ methods: [method()] }, identity, Money.of("0.07", "MAD"))).toThrow(PaymentMethodConfigurationError);
  });
  it("denies disabled methods and unconfigured currencies", () => {
    expect(() => configuredPaymentMethod({ methods: [{ ...method(), enabled: false }] }, method().key, Money.of("0.07", "EUR"))).toThrow(PaymentMethodConfigurationError);
    expect(() => configuredPaymentMethod({ methods: [method()] }, method().key, Money.of("0.07", "USD"))).toThrow(PaymentMethodConfigurationError);
  });
  it.each(["0.00", "-0.01"])("denies a nonpositive receipt intent %s", value => {
    expect(() => configuredPaymentMethod({ methods: [method()] }, method().key, Money.of(value, "MAD"))).toThrow(PaymentMethodConfigurationError);
  });
  it("requires explicit enablement and all three configured labels", () => {
    const implicit: Partial<ReturnType<typeof method>> = method(); delete implicit.enabled;
    const incomplete: Partial<ReturnType<typeof method>["labels"]> = method().labels; delete incomplete.ar;
    expect(paymentMethodPolicySchema.safeParse({ methods: [implicit] }).success).toBe(false);
    expect(paymentMethodPolicySchema.safeParse({ methods: [{ ...method(), labels: incomplete }] }).success).toBe(false);
    expect(paymentMethodPolicySchema.safeParse({ methods: [{ ...method(), labels: { ...method().labels, fr: "   " } }] }).success).toBe(false);
  });
  it("rejects duplicate identities and currencies and unimplemented provider protocols", () => {
    expect(paymentMethodPolicySchema.safeParse({ methods: [method(), method()] }).success).toBe(false);
    expect(paymentMethodPolicySchema.safeParse({ methods: [{ ...method(), currencies: ["MAD", "MAD"] }] }).success).toBe(false);
    expect(paymentMethodPolicySchema.safeParse({ methods: [{ ...method(), adapter: "unimplemented" }] }).success).toBe(false);
  });
});
