import { ReconciliationSourceError, type ReconciliationMeasure } from "./reconciliation";

/** Operational counts retain their configured unit and exact integer arithmetic. */
export function quantityReconciliationMeasure(unit: string | null): ReconciliationMeasure<bigint> {
  if (unit !== null && !unit.trim()) throw new ReconciliationSourceError();
  return {
    unit: unit === null ? "QUANTITY" : `QUANTITY:${unit}`,
    zero: () => 0n,
    assert(value) { if (typeof value !== "bigint") throw new ReconciliationSourceError(); },
    add: (left, right) => left + right,
    subtract: (left, right) => left - right,
    compare: (left, right) => left < right ? -1 : left > right ? 1 : 0,
    serialize: value => value.toString()
  };
}
