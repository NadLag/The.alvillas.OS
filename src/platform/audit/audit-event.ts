export const requiredAuditEventCatalog = [
  {
    category: "permission_change",
    label: "Permission change",
    actions: ["authorization.role.create", "authorization.role.update", "authorization.permission.change"]
  },
  {
    category: "role_assignment",
    label: "Role assignment",
    actions: ["authorization.role_assignment.create", "authorization.role_assignment.archive"]
  },
  {
    category: "financial_edit",
    label: "Financial edit",
    actions: ["reservation.revenue.posted", "reservation.revenue.reversed", "financial_transaction.void"]
  },
  {
    category: "payout",
    label: "Payout",
    actions: ["payout.create", "payout.pay", "payout.void"]
  },
  {
    category: "approval",
    label: "Approval",
    actions: ["approval.request", "approval.approve", "approval.reject"]
  },
  {
    category: "proxy_validation",
    label: "Proxy validation",
    actions: ["task.proxy_validate"]
  },
  {
    category: "agreement_change",
    label: "Agreement change",
    actions: ["owner_agreement.change"]
  },
  {
    category: "expense_modification",
    label: "Expense modification",
    actions: ["expense.create", "expense.update", "expense.void"]
  },
  {
    category: "wallet_adjustment",
    label: "Wallet adjustment",
    actions: ["wallet.adjustment"]
  },
  {
    category: "bank_reconciliation",
    label: "Bank reconciliation",
    actions: ["bank_reconciliation.match", "bank_reconciliation.reopen"]
  },
  {
    category: "report_generation",
    label: "Report generation",
    actions: ["report.generate", "audit_log.export", "owner_statement.view"]
  },
  {
    category: "account_access",
    label: "Account access",
    actions: [
      "identity.login",
      "identity.session.revoke",
      "identity.account.suspend",
      "identity.account.reactivate",
      "identity.recovery_code.issue",
      "identity.password.recover",
      "identity.mfa.totp.start",
      "identity.mfa.totp.confirm",
      "identity.passkey.register",
      "identity.passkey.verify"
    ]
  }
] as const;

export type RequiredAuditEventCategory = (typeof requiredAuditEventCatalog)[number]["category"];

export const requiredAuditCategories = requiredAuditEventCatalog.map((event) => event.category);

const reasonRequiredActionTokens = [
  "void",
  "adjust",
  "adjustment",
  "reopen",
  "override",
  "reversed"
] as const;

export function auditActionRequiresReason(action: string): boolean {
  const normalized = action.toLowerCase();

  return reasonRequiredActionTokens.some((token) => normalized.split(/[.:_-]/u).includes(token));
}

export function requiredAuditCategoryForAction(action: string): RequiredAuditEventCategory | null {
  const match = requiredAuditEventCatalog.find((event) =>
    (event.actions as readonly string[]).includes(action)
  );

  return match?.category ?? null;
}

export type AuditEvent = {
  organizationId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  ipAddress?: string | null;
  deviceId?: string | null;
  propertyScopeId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  requestId: string;
  occurredAt: Date;
};
