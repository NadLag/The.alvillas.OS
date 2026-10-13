export const requiredAuditEventCoverage = [
  {
    category: "permission_change",
    label: "Permission change",
    canonicalActions: ["authorization.role.create", "authorization.role.update"]
  },
  {
    category: "role_assignment",
    label: "Role assignment",
    canonicalActions: ["authorization.role_assignment.create"]
  },
  {
    category: "financial_edit",
    label: "Financial edit",
    canonicalActions: [
      "reservation.revenue.posted",
      "reservation.revenue.reversed",
      "airbnb.settlement.imported",
      "airbnb.settlement.reversed"
    ]
  },
  {
    category: "payout",
    label: "Payout",
    canonicalActions: ["payout.payment.created", "payout.payment.reversed"]
  },
  {
    category: "approval",
    label: "Approval",
    canonicalActions: ["approval.approved", "approval.rejected"]
  },
  {
    category: "proxy_validation",
    label: "Proxy validation",
    canonicalActions: ["task.proxy_validation.created"]
  },
  {
    category: "agreement_change",
    label: "Owner agreement change",
    canonicalActions: ["owner_agreement.changed"]
  },
  {
    category: "expense_modification",
    label: "Expense modification",
    canonicalActions: ["expense.created", "expense.updated", "expense.voided"]
  },
  {
    category: "wallet_adjustment",
    label: "Wallet adjustment",
    canonicalActions: ["wallet.adjustment.created"]
  },
  {
    category: "bank_reconciliation",
    label: "Bank reconciliation",
    canonicalActions: ["bank_reconciliation.matched", "airbnb.settlement.imported"]
  },
  {
    category: "report_generation",
    label: "Report generation",
    canonicalActions: ["audit.export.generated", "owner_statement.view"]
  },
  {
    category: "account_access",
    label: "Account access",
    canonicalActions: [
      "identity.account.login",
      "identity.session.revoke",
      "identity.account.suspend",
      "identity.account.reactivate",
      "identity.account.recover",
      "identity.mfa.totp.enrollment_started",
      "identity.mfa.totp.confirmed",
      "identity.passkey.registered",
      "identity.passkey.authentication_verified"
    ]
  }
] as const;

export type RequiredAuditEventCategory = (typeof requiredAuditEventCoverage)[number]["category"];

export const requiredAuditEventCategories = requiredAuditEventCoverage.map(
  (entry) => entry.category
);
