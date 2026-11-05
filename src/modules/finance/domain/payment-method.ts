import { z } from "zod";
import type { Money } from "@/platform/money/money";
import { receivablePolicySchema } from "./receivable";

export const paymentMethodPolicyKey = "finance.payment_methods";
const key = z.string().regex(/^[a-z][a-z0-9_.-]{0,119}$/u), label = z.string().trim().min(1).max(120), currency = z.string().regex(/^[A-Z]{3}$/u);
/** Method identities and labels are configured lookup data; adapter identities select technical provider protocols. */
export const paymentMethodSchema = z.object({ key, labels: z.object({ en: label, fr: label, ar: label }).strict(), enabled: z.boolean(),
  provider_account_code: receivablePolicySchema.shape.account_codes.element.optional(),
  adapter: z.enum(["cash", "bank_transfer", "airbnb_settlement", "manual", "paypal"]),
  currencies: z.array(currency).min(1).refine(rows => new Set(rows).size === rows.length, "duplicate_payment_method_currency") }).strict();
export const paymentMethodPolicySchema = z.object({ methods: z.array(paymentMethodSchema).min(1)
  .refine(rows => new Set(rows.map(row => row.key)).size === rows.length, "duplicate_payment_method_key") }).strict();
export type ConfiguredPaymentMethod = z.infer<typeof paymentMethodSchema>;
export const paymentMethodCatalogInputSchema = z.object({ currency: currency.optional() }).strict();
export const paymentMethodCatalogSchema = z.object({ policy: z.object({ id: z.uuid(), version: z.number().int().positive() }).strict(), currency,
  currencies: z.array(z.object({ code: currency, minorUnit: z.number().int().min(0).max(2) }).strict()),
  methods: z.array(paymentMethodSchema.extend({ enabled: z.literal(true) })) }).strict();
export class PaymentMethodConfigurationError extends Error { constructor() { super("payment_method_configuration_unavailable"); } }
export class PaymentMethodAccessError extends Error { constructor() { super("payment_method_access_denied"); } }
export class PaymentMethodChangedError extends Error { constructor() { super("payment_method_configuration_changed"); } }
export class PaymentMethodSourceError extends Error { constructor() { super("payment_method_source_unavailable"); } }

export function configuredPaymentMethod(raw: unknown, methodKey: string, amount: Money): ConfiguredPaymentMethod {
  const policy = paymentMethodPolicySchema.safeParse(raw); if (!policy.success) throw new PaymentMethodConfigurationError();
  const method = policy.data.methods.find(row => row.key === methodKey);
  if (!method?.enabled || !method.currencies.includes(amount.currency) || !amount.amount.gt(0)) throw new PaymentMethodConfigurationError();
  return method;
}
