import { z } from "zod";
import { Money } from "@/platform/money/money";
import { employeeReconciliation } from "../domain/employee-reconciliation";
import { EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import type { FinanceActorContext } from "./finance-access";
import type { prepareEmployeeCompensationSettlement } from "./employee-compensation-settlement";

/** Prepared sources already hold the original claim lock and independently authorized journal/funding context. */
export async function employeeSettlementReconciliation(ctx: FinanceActorContext,
  source: Awaited<ReturnType<typeof prepareEmployeeCompensationSettlement>>, claimId: string, actionJournalId: string, reason: string) {
  if (!source.existing || source.existing.claimId !== claimId || source.row.organizationId !== ctx.organizationId) throw new EmployeeCompensationRunConflictError();
  const currency = source.retained.amount.currency, denomination = await source.claims.currency(currency);
  if (!denomination) throw new EmployeeCompensationRunConflictError();
  const journals = await source.payables.journals(claimId), outstanding = await source.payables.outstanding({ claimId, personId: source.retained.personId, currency });
  return employeeReconciliation({ organizationId: ctx.organizationId, claimId, personId: source.retained.personId, currency, minorUnit: denomination.minorUnit,
    recognitionJournalIds: source.existing.lines.map(line => line.transactionId), outstanding, actionJournalId, reason,
    journals: journals.map(journal => ({ id: journal.id, organizationId: journal.organizationId, sealed: journal.sealed,
      reversesTransactionId: journal.reversesTransactionId, postings: journal.postings.map(posting => {
        const dimensions = z.record(z.string(), z.unknown()).parse(posting.dimensions ?? {});
        return { id: posting.id, organizationId: posting.organizationId, transactionId: posting.transactionId, ledgerAccountId: posting.ledgerAccountId,
          side: posting.side, amount: Money.of(posting.amount.toString(), posting.currency), bucket: posting.bucket, account: posting.ledgerAccount,
          claimId: typeof dimensions.employee_compensation_claim_id === "string" ? dimensions.employee_compensation_claim_id : null,
          personId: typeof dimensions.employee_person_id === "string" ? dimensions.employee_person_id : null };
      }) })) });
}
