import type { Money } from "@/platform/money/money";
import { reconciliationEvidencePlan, ReconciliationSourceError, type ReconciliationEvidence } from "./reconciliation";
import { moneyReconciliationMeasure } from "./reconciliation-money";

type OriginalPosting = { id: string; amount: Money };

/** The adapter passes sealed native postings; a missing receipt needs retained nonmonetary source evidence. */
export function otaReconciliationPlan(input: {
  currency: string;
  minorUnit: number;
  expectedPayout: Money;
  actualReceipt: Money;
  expected: readonly OriginalPosting[];
  actual: readonly OriginalPosting[];
  zeroReceiptEvidence: ReconciliationEvidence | null;
  reason: string;
  varianceAction: string | null;
}) {
  const measure = moneyReconciliationMeasure(input.currency, input.minorUnit), zero = measure.zero();
  const source = (posting: OriginalPosting) => ({ sourceKey: posting.id, original: posting.amount, amount: posting.amount, allocatedBefore: zero });
  for (const value of [input.expectedPayout, input.actualReceipt]) measure.assert(value);
  if (measure.compare(input.expectedPayout, zero) <= 0 || measure.compare(input.actualReceipt, zero) < 0 ||
      input.expected.some(posting => input.actual.some(actual => actual.id === posting.id))) throw new ReconciliationSourceError();
  const absent = measure.compare(input.actualReceipt, zero) === 0;
  if (absent ? input.actual.length !== 0 || input.zeroReceiptEvidence?.side !== "ACTUAL" : input.zeroReceiptEvidence !== null) throw new ReconciliationSourceError();
  const plan = reconciliationEvidencePlan(measure, { expected: input.expected.map(source), actual: input.actual.map(source),
    evidence: input.zeroReceiptEvidence ? [input.zeroReceiptEvidence] : [], reason: input.reason, varianceAction: input.varianceAction });
  if (plan.expected !== measure.serialize(input.expectedPayout) || plan.actual !== measure.serialize(input.actualReceipt)) throw new ReconciliationSourceError();
  return { state: plan.variance === measure.serialize(zero) ? "MATCHED" as const : "OPEN_VARIANCE" as const, plan };
}
