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

/** Source adapters supply authorized immutable facts and derived prior allocations, never editable balances. */
export function reconciliationPlan<T>(measure: ReconciliationMeasure<T>, input: {
  expected: readonly ReconciliationAllocation<T>[];
  actual: readonly ReconciliationAllocation<T>[];
  evidence: readonly ReconciliationEvidence[];
  tolerance: T;
  reason: string;
  varianceAction: string | null;
}) {
  const zero = measure.zero(); measure.assert(input.tolerance);
  if (measure.compare(input.tolerance, zero) < 0 || !input.reason.trim()) throw new ReconciliationSourceError();
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
  const classification = exact ? "EXACT" as const : measure.compare(absolute(variance), input.tolerance) <= 0 ? "WITHIN_TOLERANCE" as const : "OUTSIDE_TOLERANCE" as const;
  return { unit: measure.unit, expected: measure.serialize(expected.total), actual: measure.serialize(actual.total), variance: measure.serialize(variance),
    classification, reason: input.reason.trim(), varianceAction: exact ? null : input.varianceAction!.trim(),
    allocations: { expected: expected.allocations, actual: actual.allocations }, evidence: [...input.evidence].sort((left, right) => (left.side + ":" + left.sourceKey).localeCompare(right.side + ":" + right.sourceKey)) };
}
