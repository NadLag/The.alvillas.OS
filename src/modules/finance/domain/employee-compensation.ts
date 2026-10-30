import { z } from "zod";
import { Money } from "@/platform/money/money";

const positiveUnits = z.string().regex(/^[1-9]\d{0,29}$/u);
export const employeeCompensationBasisSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("PER_JOB"), jobs: positiveUnits }).strict(),
  z.object({ mode: z.literal("PER_HOUR"), seconds: positiveUnits }).strict(),
  z.object({ mode: z.literal("PER_MONTH"), numerator: positiveUnits, denominator: positiveUnits }).strict(),
  z.object({ mode: z.literal("PERCENTAGE"), baseAmount: z.string().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u) }).strict()
]);
export type EmployeeCompensationBasis = z.infer<typeof employeeCompensationBasisSchema>;

/** A contractual calculation, independent of approval and recognition of earned work. */
export function employeeCompensationAmount(rate: { mode: string; amount: Money }, rawBasis: unknown): Money {
  const basis = employeeCompensationBasisSchema.parse(rawBasis);
  if (rate.mode !== basis.mode || rate.amount.amount.isNegative()) throw new Error("Compensation basis must match the contractual rate");
  switch (basis.mode) {
    case "PER_JOB": return rate.amount.multiplyRatio(BigInt(basis.jobs), 1n);
    case "PER_HOUR": return rate.amount.multiplyRatio(BigInt(basis.seconds), 3600n);
    case "PER_MONTH": return rate.amount.multiplyRatio(BigInt(basis.numerator), BigInt(basis.denominator));
    case "PERCENTAGE": {
      if (rate.amount.amount.gt(100)) throw new Error("Compensation percentage exceeds one hundred");
      return Money.of(basis.baseAmount, rate.amount.currency).multiplyRatio(BigInt(rate.amount.toJSON().amount.replace(".", "")), 10000n);
    }
  }
}
