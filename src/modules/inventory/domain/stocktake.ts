import { z } from "zod";

// Count inputs use PostgreSQL bigint's range; derived ledger quantities remain
// decimal strings so neither JSON nor browser arithmetic loses integer precision.
const largestCount = 9_223_372_036_854_775_807n;
export const stockQuantitySchema = z.string().regex(/^(?:0|-?[1-9]\d{0,39})$/u);
export const countedStockQuantitySchema = z.string().regex(/^(?:0|[1-9]\d{0,18})$/u)
  .pipe(z.string().refine(value => BigInt(value) <= largestCount));
export const stockRevisionSchema = countedStockQuantitySchema;

export type StockPosition = { quantity: string; revision: string };
export class StocktakeConflictError extends Error {
  constructor(readonly expected: StockPosition, readonly current: StockPosition) {
    super("STOCKTAKE_CONFLICT");
    this.name = "StocktakeConflictError";
  }
}

export function decideStocktake(input: {
  expected: StockPosition;
  current: StockPosition;
  countedQuantity: string;
  configuredMinimum: string | null;
}): { quantity: string; delta: string; variance: boolean; belowMinimum: boolean } {
  const expected = { quantity: stockQuantitySchema.parse(input.expected.quantity), revision: stockRevisionSchema.parse(input.expected.revision) };
  const current = { quantity: stockQuantitySchema.parse(input.current.quantity), revision: stockRevisionSchema.parse(input.current.revision) };
  const quantity = countedStockQuantitySchema.parse(input.countedQuantity);
  const minimum = input.configuredMinimum === null ? null : countedStockQuantitySchema.parse(input.configuredMinimum);
  if (expected.quantity !== current.quantity || expected.revision !== current.revision) throw new StocktakeConflictError(expected, current);
  const delta = BigInt(quantity) - BigInt(current.quantity);
  return { quantity, delta: delta.toString(), variance: delta !== 0n, belowMinimum: minimum !== null && BigInt(quantity) < BigInt(minimum) };
}
