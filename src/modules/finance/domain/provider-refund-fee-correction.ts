import type { Money } from "@/platform/money/money";
import { ExternalPaymentRefundError } from "@/modules/finance/domain/external-payment-refund-intent";

/** A verified fee return reduces only the current native cost in its original currency. */
export function providerRefundFeeCorrectionTarget(input: { originalFee: Money; currentCost: Money; gross: Money; returnedFee: Money; merchantDebit: Money }) {
  const { originalFee, currentCost, gross, returnedFee, merchantDebit } = input, amounts = [originalFee, currentCost, gross, returnedFee, merchantDebit];
  if (amounts.some(amount => amount.currency !== originalFee.currency || amount.amount.lt(0)) || !originalFee.amount.gt(0) || !currentCost.amount.gt(0) || !gross.amount.gt(0) || !returnedFee.amount.gt(0) ||
    currentCost.amount.gt(originalFee.amount) || returnedFee.amount.gt(currentCost.amount) || !gross.subtract(returnedFee).equals(merchantDebit)) throw new ExternalPaymentRefundError();
  const remainingCost = currentCost.subtract(returnedFee);
  return { returnedFee, remainingCost, disposition: remainingCost.amount.isZero() ? "VOID_ORIGINAL_REMAINDER" as const : "CORRECT_ORIGINAL_REMAINDER" as const };
}
