import { z } from "zod";
import { Money } from "@/platform/money/money";
import type { paymentRefundIntent } from "./payment-refund";

const amount = z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u), currency = z.string().regex(/^[A-Z]{3}$/u),
  providerMoney = z.object({ value: amount, currency_code: currency }), canonicalMoney = z.object({ amount: z.string().regex(/^(?:0|[1-9]\d{0,15})\.\d{2}$/u), currency }).strict();
export const providerRefundSettlementSchema = z.object({ schemaVersion: z.literal(1), basis: z.literal("ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN"),
  gross: canonicalMoney, fee: canonicalMoney, net: canonicalMoney, totalRefunded: canonicalMoney.nullable() }).strict();

/** Missing or unsupported settlement never implies zero fees or an invented merchant debit. */
export function payPalRefundSettlement(raw: unknown, input: ReturnType<typeof paymentRefundIntent>) {
  const parsed = z.object({ gross_amount: providerMoney, paypal_fee: providerMoney, net_amount: providerMoney,
    total_refunded_amount: providerMoney.optional(), paypal_fee_in_receivable_currency: providerMoney.optional(),
    platform_fees: z.array(z.unknown()).max(0).optional(), net_amount_breakdown: z.array(z.unknown()).max(0).optional(), exchange_rate: z.never().optional() }).safeParse(raw);
  if (!parsed.success) return null;
  const { gross_amount: grossSource, paypal_fee: feeSource, net_amount: netSource, total_refunded_amount: totalSource, paypal_fee_in_receivable_currency: feeReceivable } = parsed.data,
    sources = [grossSource, feeSource, netSource, ...totalSource ? [totalSource] : [], ...feeReceivable ? [feeReceivable] : []];
  if (sources.some(source => source.currency_code !== input.currency)) return null;
  const gross = Money.of(grossSource.value, input.currency), fee = Money.of(feeSource.value, input.currency), net = Money.of(netSource.value, input.currency),
    total = totalSource ? Money.of(totalSource.value, input.currency) : null;
  if (!gross.equals(Money.of(input.amount, input.currency)) || !gross.subtract(fee).equals(net) || total && total.amount.lt(gross.amount) || feeReceivable && !fee.equals(Money.of(feeReceivable.value, input.currency))) return null;
  return providerRefundSettlementSchema.parse({ schemaVersion: 1, basis: "ORIGINAL_PROVIDER_PAYABLE_BREAKDOWN", gross: gross.toJSON(), fee: fee.toJSON(), net: net.toJSON(), totalRefunded: total?.toJSON() ?? null });
}
