import { describe, expect, it } from "vitest";
import {
  auditActionRequiresReason,
  requiredAuditCategories,
  requiredAuditCategoryForAction
} from "@/platform/audit/audit-event";

describe("audit event catalog", () => {
  it("covers every required spec audit category", () => {
    expect(requiredAuditCategories.sort()).toEqual([
      "account_access",
      "agreement_change",
      "approval",
      "bank_reconciliation",
      "expense_modification",
      "financial_edit",
      "payout",
      "permission_change",
      "proxy_validation",
      "report_generation",
      "role_assignment",
      "wallet_adjustment"
    ]);
  });

  it("maps implemented sensitive actions to required categories", () => {
    expect(requiredAuditCategoryForAction("authorization.role.update")).toBe("permission_change");
    expect(requiredAuditCategoryForAction("authorization.role_assignment.create")).toBe("role_assignment");
    expect(requiredAuditCategoryForAction("reservation.revenue.reversed")).toBe("financial_edit");
    expect(requiredAuditCategoryForAction("owner_statement.view")).toBe("report_generation");
    expect(requiredAuditCategoryForAction("identity.login")).toBe("account_access");
  });

  it("identifies reason-required actions", () => {
    expect(auditActionRequiresReason("financial_transaction.void")).toBe(true);
    expect(auditActionRequiresReason("wallet.adjustment")).toBe(true);
    expect(auditActionRequiresReason("bank_reconciliation.reopen")).toBe(true);
    expect(auditActionRequiresReason("approval.override")).toBe(true);
    expect(auditActionRequiresReason("identity.login")).toBe(false);
  });
});

