import { describe, expect, it } from "vitest";
import { groupedAccountMovements } from "@/modules/finance/domain/transaction-group";

describe("posting-derived transaction group movements", () => {
  it("conserves decimal precision and separates locations, ownership and currencies", () => {
    const bank = { name: "Bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" };
    const owner = { name: "Owner", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" };
    const result = groupedAccountMovements([
      { ledgerAccountId: "bank", side: "DEBIT", currency: "MAD", amount: "100.01", account: bank },
      { ledgerAccountId: "bank", side: "CREDIT", currency: "MAD", amount: "25.03", account: bank },
      { ledgerAccountId: "owner", side: "CREDIT", currency: "MAD", amount: "100.01", account: owner },
      { ledgerAccountId: "owner", side: "DEBIT", currency: "MAD", amount: "25.03", account: owner },
      { ledgerAccountId: "bank", side: "DEBIT", currency: "EUR", amount: "0.10", account: bank },
      { ledgerAccountId: "bank", side: "DEBIT", currency: "EUR", amount: "0.20", account: bank }
    ]);
    expect(result).toEqual([
      { accountId: "bank", name: "Bank", accountType: "ASSET_LOCATION", currency: "MAD", amount: "74.98" },
      { accountId: "owner", name: "Owner", accountType: "CLAIM_OWNERSHIP", currency: "MAD", amount: "74.98" },
      { accountId: "bank", name: "Bank", accountType: "ASSET_LOCATION", currency: "EUR", amount: "0.30" }
    ]);
  });
  it("retains negative net movements and does not invent a balance for an empty group", () => {
    expect(groupedAccountMovements([])).toEqual([]);
    expect(groupedAccountMovements([{ ledgerAccountId: "bank", side: "CREDIT", currency: "MAD", amount: "7.45",
      account: { name: "Bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" } }])[0].amount).toBe("-7.45");
  });
});
