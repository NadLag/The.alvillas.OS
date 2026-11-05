import type { TenantTransaction } from "@/platform/db/tenant";
import type { Money } from "@/platform/money/money";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { PaymentMethodRepository } from "../infrastructure/payment-method-repository";
import { paymentMethodPolicyKey, PaymentMethodConfigurationError, PaymentMethodSourceError, type ConfiguredPaymentMethod } from "../domain/payment-method";

export async function guestPaymentMethodScopes(tx: TenantTransaction, organizationId: string, reservationId: string, at: Date) {
  const repository = new GuestDepositRepository(tx, organizationId), booking = await repository.source(reservationId), source = await repository.policySource(reservationId);
  if (!booking || !source) throw new PaymentMethodSourceError();
  return new ReservationConfigScopeRepository(tx, organizationId).scopes({ propertyId: booking.propertyId, source: source.source, asOf: at });
}
export async function lockGuestPaymentMethods(tx: TenantTransaction, organizationId: string, scopes: Awaited<ReturnType<typeof guestPaymentMethodScopes>>) {
  const rules = new ConfigRuleRepository(tx, organizationId);
  for (const scope of [...scopes].sort((a, b) => (a.scopeType + ":" + (a.scopeId ?? "")).localeCompare(b.scopeType + ":" + (b.scopeId ?? ""))))
    await rules.lockVersion(paymentMethodPolicyKey, scope.scopeType, scope.scopeId);
}

/** Called after native source authorization; only the selected receipt protocol is disclosed. */
export async function reviewGuestPaymentMethod(tx: TenantTransaction, organizationId: string, reservationId: string, at: Date,
  amount: Money, key: string | undefined, adapters: readonly ConfiguredPaymentMethod["adapter"][]) {
  const catalog = await new PaymentMethodRepository(tx, organizationId).optionalCatalog({ at, currency: amount.currency,
    scopes: await guestPaymentMethodScopes(tx, organizationId, reservationId, at) });
  if (!catalog) return null;
  const methods = catalog.methods.filter(row => adapters.includes(row.adapter));
  const method = key ? methods.find(row => row.key === key) : methods.length === 1 ? methods[0] : null;
  if (!method || !amount.amount.gt(0)) throw new PaymentMethodConfigurationError();
  return { fingerprint: catalog.identity, method };
}
