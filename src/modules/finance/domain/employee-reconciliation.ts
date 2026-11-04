import { z } from "zod";
import type { Money } from "@/platform/money/money";
import { reconciliationEvidencePlan, ReconciliationSourceError, type ReconciliationAllocation } from "./reconciliation";
import { moneyReconciliationMeasure } from "./reconciliation-money";
import { reconciliationEvidenceSnapshotSchema } from "./reconciliation-snapshot";

export const employeeReconciliationSnapshotSchema = z.object({
  provider: z.literal("STAFF"), sourceType: z.literal("EMPLOYEE_CLAIM"), sourceId: z.uuid(), state: z.enum(["MATCHED", "OPEN_VARIANCE"]),
  plan: reconciliationEvidenceSnapshotSchema
}).strict();

export type EmployeeReconciliationPosting = {
  id: string; organizationId: string; transactionId: string; ledgerAccountId: string; side: string; amount: Money; bucket: string | null;
  claimId: string | null; personId: string | null;
  account: { code: string | null; accountType: string; normalSide: string };
};
export type EmployeeReconciliationJournal = {
  id: string; organizationId: string; sealed: boolean; reversesTransactionId: string | null; postings: readonly EmployeeReconciliationPosting[];
};

/** Compare original earned liability with all actual payment/offset journals, including their exact opposites. */
export function employeeReconciliation(input: {
  organizationId: string; claimId: string; personId: string; currency: string; minorUnit: number;
  journals: readonly EmployeeReconciliationJournal[]; outstanding: Money; actionJournalId: string; reason: string;
  recognitionJournalIds: readonly string[];
}) {
  for (const id of [input.organizationId, input.claimId, input.personId, input.actionJournalId]) z.uuid().parse(id);
  const measure = moneyReconciliationMeasure(input.currency, input.minorUnit), zero = measure.zero(); measure.assert(input.outstanding);
  if (measure.compare(input.outstanding, zero) < 0) throw new ReconciliationSourceError();
  const journals = new Map(input.journals.map(journal => [journal.id, journal]));
  const recognized = new Set(input.recognitionJournalIds), observedRecognition = new Set<string>();
  if (!recognized.size || recognized.size !== input.recognitionJournalIds.length) throw new ReconciliationSourceError();
  if (journals.size !== input.journals.length || !journals.has(input.actionJournalId)) throw new ReconciliationSourceError();
  const expected: ReconciliationAllocation<Money>[] = [], actual: ReconciliationAllocation<Money>[] = [], identities = new Set<string>(), reversed = new Set<string>();
  for (const journal of input.journals) {
    if (journal.organizationId !== input.organizationId || !journal.sealed) throw new ReconciliationSourceError();
    const original = journal.reversesTransactionId ? journals.get(journal.reversesTransactionId) : null;
    if (journal.reversesTransactionId && (!original || original.reversesTransactionId)) throw new ReconciliationSourceError();
    if (original) { if (reversed.has(original.id)) throw new ReconciliationSourceError(); reversed.add(original.id); }
    let sources = 0;
    for (const posting of journal.postings) {
      if (posting.account.code !== "EMPLOYEE_PAYABLE") continue;
      if (identities.has(posting.id) || posting.organizationId !== input.organizationId || posting.transactionId !== journal.id ||
          posting.claimId !== input.claimId || posting.personId !== input.personId || posting.account.accountType !== "CLAIM_OWNERSHIP" ||
          posting.account.normalSide !== "CREDIT" || !["DEBIT", "CREDIT"].includes(posting.side)) throw new ReconciliationSourceError();
      identities.add(posting.id); sources++; measure.assert(posting.amount);
      if (measure.compare(posting.amount, zero) <= 0) throw new ReconciliationSourceError();
      const earned = posting.bucket === "EMPLOYEE_COMPENSATION";
      if (earned ? !recognized.has(original?.id ?? journal.id) : recognized.has(journal.id)) throw new ReconciliationSourceError();
      if (earned && !original) observedRecognition.add(journal.id);
      if (!earned && !["EMPLOYEE_PAYMENT", "COMPENSATION_OFFSET"].some(bucket => bucket === posting.bucket)) throw new ReconciliationSourceError();
      const positive = posting.side === (earned ? "CREDIT" : "DEBIT");
      if (positive === Boolean(original)) throw new ReconciliationSourceError();
      if (original && !original.postings.some(prior => prior.ledgerAccountId === posting.ledgerAccountId && prior.bucket === posting.bucket &&
          prior.claimId === posting.claimId && prior.personId === posting.personId && prior.side !== posting.side &&
          measure.compare(prior.amount, posting.amount) === 0)) throw new ReconciliationSourceError();
      (earned ? expected : actual).push({ sourceKey: posting.id, original: positive ? posting.amount : measure.subtract(zero, posting.amount),
        amount: posting.amount, allocatedBefore: zero });
    }
    if (!sources) throw new ReconciliationSourceError();
  }
  if ([...recognized].some(id => !observedRecognition.has(id))) throw new ReconciliationSourceError();
  const plan = reconciliationEvidencePlan(measure, { expected, actual, evidence: [], reason: input.reason,
    varianceAction: `STAFF_SETTLEMENT:${input.actionJournalId}` });
  if (plan.variance !== measure.serialize(measure.subtract(zero, input.outstanding))) throw new ReconciliationSourceError();
  return employeeReconciliationSnapshotSchema.parse({ provider: "STAFF", sourceType: "EMPLOYEE_CLAIM", sourceId: input.claimId,
    state: plan.variance === measure.serialize(zero) ? "MATCHED" : "OPEN_VARIANCE", plan });
}
