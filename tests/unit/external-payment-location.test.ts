import { describe, expect, it } from "vitest";
import { assertExternalPaymentLocation } from "@/modules/finance/application/external-payment-location";
import { PaymentMethodConfigurationError, type ConfiguredPaymentMethod } from "@/modules/finance/domain/payment-method";
const method: ConfiguredPaymentMethod = { key: "confirmed-paypal", labels: { en: "PayPal", fr: "PayPal", ar: "باي بال" }, enabled: true, adapter: "paypal", currencies: ["MAD"], provider_account_code: "PAYPAL_MERCHANT_BALANCE" };
const account = { code: "PAYPAL_MERCHANT_BALANCE", accountType: "ASSET_LOCATION", normalSide: "DEBIT", teamWallet: null };
describe("configured actual provider money location", () => {
  it("accepts the original explicitly configured merchant balance account", () => { expect(() => assertExternalPaymentLocation(method, account)).not.toThrow(); });
  it("refuses to infer a merchant location from an unconfigured method", () => { expect(() => assertExternalPaymentLocation({ ...method, provider_account_code: undefined }, account)).toThrow(PaymentMethodConfigurationError); });
  it("refuses a different actual bank account even when the caller can post to it", () => { expect(() => assertExternalPaymentLocation(method, { ...account, code: "COMPANY_BANK" })).toThrow(PaymentMethodConfigurationError); });
  it("refuses to treat an employee's physical custody wallet as provider-held funds", () => { expect(() => assertExternalPaymentLocation(method, { ...account, teamWallet: { id: "original-staff-wallet" } })).toThrow(PaymentMethodConfigurationError); });
  it.each(["CLAIM_OWNERSHIP", "INCOME"])("refuses a %s account instead of an actual location", accountType => { expect(() => assertExternalPaymentLocation(method, { ...account, accountType })).toThrow(PaymentMethodConfigurationError); });
  it("refuses the wrong normal side", () => { expect(() => assertExternalPaymentLocation(method, { ...account, normalSide: "CREDIT" })).toThrow(PaymentMethodConfigurationError); });
});
