import { describe, expect, it } from "vitest";
import {
  allocateConfiguredExpense,
  evaluateConfiguredApproval,
  planConfiguredPayout
} from "@/modules/finance/domain/configured-finance-rules";
import { Money } from "@/platform/money/money";

describe("configured finance rule consumers", () => {
  it("evaluates approval thresholds, emergency bypass, expense allocation and payout holds", () => {
    const approval = {
      thresholds: [
        {
          key: "maintenance-high",
          category: "maintenance",
          amount: "1000.00",
          currency: "MAD",
          emergency_bypass_owner: true,
          requires_approval_from: ["manager_owner"]
        }
      ]
    };
    const regularDecision = evaluateConfiguredApproval(approval, {
      category: "maintenance",
      amount: Money.of("1250.00", "MAD")
    });
    const emergencyDecision = evaluateConfiguredApproval(approval, {
      category: "maintenance",
      amount: Money.of("1250.00", "MAD"),
      emergency: true
    });

    expect(regularDecision).toMatchObject({
      matchedThresholdKey: "maintenance-high",
      requiredSteps: ["manager_owner"],
      postHocOwnerNotificationRequired: false
    });
    expect(emergencyDecision).toMatchObject({
      matchedThresholdKey: "maintenance-high",
      requiredSteps: ["manager"],
      postHocOwnerNotificationRequired: true
    });

    const allocation = allocateConfiguredExpense(
      {
        default_treatment: "ALVILLAS_PAID",
        categories: {
          maintenance: {
            treatment: "SHARED",
            owner_share_bps: 3000,
            alvillas_share_bps: 7000,
            approval_rule_key: "maintenance-high"
          }
        }
      },
      {
        category: "maintenance",
        amount: Money.of("1000.00", "MAD")
      }
    );

    expect(allocation.ownerAmount.toJSON().amount).toBe("300.00");
    expect(allocation.alvillasAmount.toJSON().amount).toBe("700.00");
    expect(allocation.approvalRuleKey).toBe("maintenance-high");

    const payout = planConfiguredPayout(
      {
        cadence: "AFTER_CHECKOUT",
        hold_days: 3,
        holdback_amount: "100.00",
        holdback_currency: "MAD",
        holdback_bps: 1000
      },
      {
        availableBalance: Money.of("10000.00", "MAD"),
        checkoutDate: new Date("2028-04-14T00:00:00.000Z"),
        triggeredAt: new Date("2028-04-15T00:00:00.000Z")
      }
    );

    expect(payout.eligibleOn.toISOString()).toBe("2028-04-17T00:00:00.000Z");
    expect(payout.holdbackAmount.toJSON().amount).toBe("1100.00");
    expect(payout.payableAmount.toJSON().amount).toBe("8900.00");
  });
});
