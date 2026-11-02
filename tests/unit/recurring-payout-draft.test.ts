import { describe, expect, it } from "vitest";
import { recurringPayoutDraftPolicyKey, recurringPayoutDraftPolicySchema } from "@/modules/finance/domain/recurring-payout-draft";
import { parseConfigRuleValue } from "@/platform/config/rule-registry";
const id = "8c8e5075-451b-4252-8d19-28eecc807060";
const target = { id, starts_at: "2026-01-01T00:00:00Z", calendar: { cadence: "WEEKLY", schedule: { at: "09:00", weekday: 1 } },
  draft: { ownerId: id, propertyId: id, currency: "MAD", fundingAccountId: id, payoutMethodId: id, purpose: "Configured owner payable proposal" } };
const policy = { source: "CURRENT_DERIVED_OWNER_PAYABLE", principal: "CURRENT_CONFIGURATION_AUTHOR", amount_source: "NATIVE_UNCOMMITTED_PAYABLE",
  missed_slots: "LATEST_DUE_SLOT", open_payouts: "WAIT_FOR_TERMINAL", batch_size: 25, targets: [target] };
describe("explicit periodic native payout draft policy", () => {
  it("registers canonical native draft inputs without a runtime registry cycle", () => {
    const parsed = recurringPayoutDraftPolicySchema.parse(policy);expect(parsed.targets[0].draft).toEqual(target.draft);
    expect(parseConfigRuleValue(recurringPayoutDraftPolicyKey, policy)).toEqual(parsed);
  });
  it.each(["source", "principal", "amount_source", "missed_slots", "open_payouts", "batch_size", "targets"])("requires an explicit %s", key => {
    expect(recurringPayoutDraftPolicySchema.safeParse({ ...policy, [key]: undefined }).success).toBe(false);
  });
  it.each([{ amount: "10.00" }, { expectedSettlementAt: "2026-01-01T00:00:00Z" }, { reservationId: id }, { idempotencyKey: id }, { reason: "Override original authorization reason" }, { auto_pay: true }])("rejects substituted financial or execution facts %o", extra => {
    expect(recurringPayoutDraftPolicySchema.safeParse({ ...policy, targets: [{ ...target, draft: { ...target.draft, ...extra } }] }).success).toBe(false);
  });
  it("rejects duplicate normalized schedule IDs, event creation calendars and unbounded batches", () => {
    expect(recurringPayoutDraftPolicySchema.safeParse({ ...policy, targets: [target, { ...target, id: id.toUpperCase() }] }).success).toBe(false);
    expect(recurringPayoutDraftPolicySchema.safeParse({ ...policy, targets: [{ ...target, calendar: { cadence: "AFTER_CHECKOUT" } }] }).success).toBe(false);
    for (const batch_size of [0, 501]) expect(recurringPayoutDraftPolicySchema.safeParse({ ...policy, batch_size }).success).toBe(false);
  });
});
