/** Exact arithmetic belongs to the original measure, including Money and operational quantities. */
export type ReconciliationMeasure<T> = {
  unit: string;
  zero(): T;
  assert(value: T): void;
  add(left: T, right: T): T;
  subtract(left: T, right: T): T;
  compare(left: T, right: T): number;
  serialize(value: T): string;
};
export type ReconciliationAllocation<T> = { sourceKey: string; original: T; allocatedBefore: T; amount: T };
export type ReconciliationEvidence = { side: "EXPECTED" | "ACTUAL"; sourceKey: string; fingerprint: string };
export class ReconciliationSourceError extends Error { constructor() { super("reconciliation_source_unavailable"); } }
export class ReconciliationBudgetError extends Error { constructor() { super("reconciliation_source_budget_exceeded"); } }

export type ReconciliationInput<T> = {
  expected: readonly ReconciliationAllocation<T>[];
  actual: readonly ReconciliationAllocation<T>[];
  evidence: readonly ReconciliationEvidence[];
  reason: string;
  varianceAction: string | null;
};

/** Source adapters supply authorized immutable facts and derived prior allocations, never editable balances. */
function sourcePlan<T>(measure: ReconciliationMeasure<T>, input: ReconciliationInput<T>) {
  const zero = measure.zero();
  if (!input.reason.trim()) throw new ReconciliationSourceError();
  const absolute = (value: T) => measure.compare(value, zero) < 0 ? measure.subtract(zero, value) : value;
  const evidenceKeys = new Set<string>();
  for (const evidence of input.evidence) {
    const key = evidence.side + ":" + evidence.sourceKey;
    if (!evidence.sourceKey || evidenceKeys.has(key) || !/^[a-f0-9]{64}$/u.test(evidence.fingerprint)) throw new ReconciliationSourceError();
    evidenceKeys.add(key);
  }
  const project = (side: "EXPECTED" | "ACTUAL", sources: readonly ReconciliationAllocation<T>[]) => {
    if (!sources.length && !input.evidence.some(evidence => evidence.side === side)) throw new ReconciliationSourceError();
    const keys = new Set<string>(); let total = zero;
    const allocations = sources.map(source => {
      if (!source.sourceKey || keys.has(source.sourceKey)) throw new ReconciliationSourceError(); keys.add(source.sourceKey);
      for (const value of [source.original, source.allocatedBefore, source.amount]) measure.assert(value);
      const magnitude = absolute(source.original);
      if (measure.compare(source.amount, zero) <= 0 || measure.compare(source.allocatedBefore, zero) < 0 ||
          measure.compare(measure.add(source.allocatedBefore, source.amount), magnitude) > 0) throw new ReconciliationBudgetError();
      total = measure.add(total, measure.compare(source.original, zero) < 0 ? measure.subtract(zero, source.amount) : source.amount);
      return { sourceKey: source.sourceKey, original: measure.serialize(source.original), allocatedBefore: measure.serialize(source.allocatedBefore), amount: measure.serialize(source.amount) };
    }).sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
    return { total, allocations };
  };
  const expected = project("EXPECTED", input.expected), actual = project("ACTUAL", input.actual), variance = measure.subtract(actual.total, expected.total);
  const exact = measure.compare(variance, zero) === 0;
  if (!exact && !input.varianceAction?.trim()) throw new ReconciliationSourceError();
  return { variance, plan: { unit: measure.unit, expected: measure.serialize(expected.total), actual: measure.serialize(actual.total), variance: measure.serialize(variance),
    reason: input.reason.trim(), varianceAction: exact ? null : input.varianceAction!.trim(),
    allocations: { expected: expected.allocations, actual: actual.allocations }, evidence: [...input.evidence].sort((left, right) => (left.side + ":" + left.sourceKey).localeCompare(right.side + ":" + right.sourceKey)) } };
}

/** Preserve source evidence and signed differences without inventing a provider's tolerance policy. */
export function reconciliationEvidencePlan<T>(measure: ReconciliationMeasure<T>, input: ReconciliationInput<T>) {
  return sourcePlan(measure, input).plan;
}

export function reconciliationPlan<T>(measure: ReconciliationMeasure<T>, input: ReconciliationInput<T> & { tolerance: T }) {
  const zero = measure.zero(); measure.assert(input.tolerance);
  if (measure.compare(input.tolerance, zero) < 0) throw new ReconciliationSourceError();
  const { variance, plan } = sourcePlan(measure, input), absolute = measure.compare(variance, zero) < 0 ? measure.subtract(zero, variance) : variance;
  const classification = measure.compare(variance, zero) === 0 ? "EXACT" as const : measure.compare(absolute, input.tolerance) <= 0 ? "WITHIN_TOLERANCE" as const : "OUTSIDE_TOLERANCE" as const;
  // Preserve the existing bank snapshot's shape and property order, including recovery fingerprints.
  return { unit: plan.unit, expected: plan.expected, actual: plan.actual, variance: plan.variance, classification,
    reason: plan.reason, varianceAction: plan.varianceAction, allocations: plan.allocations, evidence: plan.evidence };
}
