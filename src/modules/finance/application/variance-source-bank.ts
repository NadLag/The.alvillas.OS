import { z } from "zod";
import { VarianceWorkflowSourceError } from "../domain/variance-workflow";
import { inspectBankVarianceSource } from "./bank-reconciliation-service";
import type { VarianceSourceAuthority } from "./variance-workflow-service";

export const authorizeBankVarianceSource: VarianceSourceAuthority = async (ctx, reference, tx, access) => {
  if (reference.provider !== "BANK") throw new VarianceWorkflowSourceError();
  const source = await inspectBankVarianceSource(ctx, reference.id, tx, access);
  const plan = z.object({ unit: z.string(), expected: z.string(), actual: z.string(), variance: z.string() }).parse(source.row.snapshot);
  return { facts: { kind: "MONEY", unit: plan.unit, currency: source.row.currency, expected: plan.expected, actual: plan.actual, variance: plan.variance },
    recheck: source.recheck };
};
