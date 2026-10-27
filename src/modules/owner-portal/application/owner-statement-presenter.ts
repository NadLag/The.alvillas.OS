import type {
  OwnerHeldBreakdown,
  OwnerStatement,
  OwnerStatementBucket,
  OwnerStatementLine
} from "@/modules/owner-portal/domain/owner-statement";
import type { Money } from "@/platform/money/money";
import {
  present,
  type FieldPolicy,
  type PresentationContext
} from "@/platform/authz/present";

export type OwnerStatementLineView = OwnerStatementLine;
export type OwnerHeldBreakdownView = OwnerHeldBreakdown;

export type OwnerStatementView = {
  organizationId: string;
  ownerId: string;
  ownerName: string;
  propertyId: string;
  propertyName: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  openingBalance: Money;
  periodCreditTotal: Money;
  periodDebitTotal: Money;
  closingBalance: Money;
  bucketTotals: Record<OwnerStatementBucket, Money>;
  bucketMovements: OwnerStatement["bucketMovements"];
  heldBreakdown: OwnerHeldBreakdownView[];
  lines: OwnerStatementLineView[];
  internalLocationCode?: string | null;
};

const ownerStatementFieldPolicy: FieldPolicy<OwnerStatementView> = {
  openingBalance: { dataClass: "financial" },
  periodCreditTotal: { dataClass: "financial" },
  periodDebitTotal: { dataClass: "financial" },
  closingBalance: { dataClass: "financial" },
  bucketTotals: { dataClass: "financial" },
  bucketMovements: { dataClass: "financial" },
  heldBreakdown: { dataClass: "financial" },
  lines: { dataClass: "financial" },
  internalLocationCode: { dataClass: "sensitive", mask: "omit" }
};

export function presentOwnerStatement(
  ctx: PresentationContext,
  statement: OwnerStatement
): OwnerStatementView {
  const view: OwnerStatementView = {
    ...statement,
    internalLocationCode: statement.heldBreakdown[0]?.locationName ?? null
  };

  return present(
    ctx,
    "view",
    {
      type: "owner_statement",
      organizationId: statement.organizationId,
      id: statement.propertyId,
      data: view
    },
    ownerStatementFieldPolicy
  ) as OwnerStatementView;
}
