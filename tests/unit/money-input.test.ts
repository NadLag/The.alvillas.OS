import { describe, expect, it } from "vitest";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import { normalizeMoneyInput } from "@/i18n/money-input";
import { Money } from "@/platform/money/money";
import { fieldCashPayloadSchema } from "@/platform/ledger/field-cash";
import { ownerPayoutDraftSchema } from "@/modules/finance/domain/owner-payout";

describe("shared localized financial input", () => {
  it.each([
    ["500.25", "500.25"], ["500,25", "500.25"], ["000500,25", "500.25"],
    ["\u0665\u0660\u0660\u066b\u0662\u0665", "500.25"], ["\u06f5\u06f0\u06f0\u066b\u06f2\u06f5", "500.25"],
    ["0,01", "0.01"], ["9999999999999999,99", "9999999999999999.99"]
  ])("retains exact cents for %s in field cash and owner payouts", (input, expected) => {
    const cash = fieldCashPayloadSchema.shape.amount.parse(normalizeAmountInput(input));
    const payout = ownerPayoutDraftSchema.shape.amount.parse(normalizeMoneyInput(input));
    expect(Money.of(cash, "MAD").toJSON().amount).toBe(expected);
    expect(Money.of(payout, "MAD").toJSON().amount).toBe(expected);
  });

  it.each(["0", "-1", "+1", "1e3", "1.001", "1,2,3", "1\u066c000", "1 000", "", "10000000000000000"])(
    "keeps invalid or out-of-range input rejected by both monetary domains: %s", input => {
      expect(fieldCashPayloadSchema.shape.amount.safeParse(normalizeAmountInput(input)).success).toBe(false);
      expect(ownerPayoutDraftSchema.shape.amount.safeParse(normalizeMoneyInput(input)).success).toBe(false);
    });
});
