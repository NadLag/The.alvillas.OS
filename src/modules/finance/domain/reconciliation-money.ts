import { Money } from "@/platform/money/money";
import { ReconciliationSourceError, type ReconciliationMeasure } from "./reconciliation";

export function moneyReconciliationMeasure(currency: string, minorUnit: number): ReconciliationMeasure<Money> {
  if (!Number.isSafeInteger(minorUnit) || minorUnit < 0 || minorUnit > 2) throw new ReconciliationSourceError();
  return { unit: "MONEY:" + currency,
    zero: () => Money.zero(currency),
    assert: value => { if (value.currency !== currency || value.amount.decimalPlaces() > minorUnit) throw new ReconciliationSourceError(); },
    add: (left, right) => left.add(right), subtract: (left, right) => left.subtract(right), compare: (left, right) => left.amount.cmp(right.amount), serialize: value => value.toJSON().amount };
}
