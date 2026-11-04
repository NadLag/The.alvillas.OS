import { createHash } from "node:crypto";
import { z } from "zod";
import { countedStockQuantitySchema, stockQuantitySchema, stockRevisionSchema } from "@/modules/inventory/domain/stocktake";
import { reconciliationEvidencePlan, ReconciliationSourceError, type ReconciliationAllocation, type ReconciliationEvidence } from "@/modules/finance/domain/reconciliation";
import { quantityReconciliationMeasure } from "@/modules/finance/domain/reconciliation-quantity";

const observationSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), locationId: z.uuid(), itemId: z.uuid(),
  expectedRevision: stockRevisionSchema, revision: stockRevisionSchema,
  expectedQuantity: stockQuantitySchema, countedQuantity: countedStockQuantitySchema
});
const movementSchema = z.object({
  id: z.uuid(), organizationId: z.uuid(), locationId: z.uuid(), itemId: z.uuid(), stocktakeId: z.uuid().nullable(),
  revision: stockRevisionSchema, quantityDelta: stockQuantitySchema
});

/** Compose only the native observation and its original adjustment, under the caller's tenant transaction. */
export function stocktakeReconciliation(input: {
  observation: z.infer<typeof observationSchema>;
  movement: z.infer<typeof movementSchema> | null;
  unit: string | null;
  reason: string;
}) {
  const observation = observationSchema.parse(input.observation), movement = input.movement === null ? null : movementSchema.parse(input.movement);
  const expected = BigInt(observation.expectedQuantity), actual = BigInt(observation.countedQuantity), delta = actual - expected;
  if (BigInt(observation.revision) !== BigInt(observation.expectedRevision) + 1n ||
      (delta === 0n ? movement !== null : movement === null)) throw new ReconciliationSourceError();
  if (movement && (movement.organizationId !== observation.organizationId || movement.locationId !== observation.locationId ||
      movement.itemId !== observation.itemId || movement.stocktakeId !== observation.id || movement.revision !== observation.revision ||
      BigInt(movement.quantityDelta) !== delta)) throw new ReconciliationSourceError();
  const measure = quantityReconciliationMeasure(input.unit), fingerprint = createHash("sha256")
    .update(JSON.stringify({ observation, movement, unit: input.unit })).digest("hex");
  const evidence: ReconciliationEvidence[] = [];
  const source = (side: "EXPECTED" | "ACTUAL", value: bigint): ReconciliationAllocation<bigint>[] => {
    const sourceKey = `${observation.id}:${side}`;
    if (value === 0n) { evidence.push({ side, sourceKey, fingerprint }); return []; }
    return [{ sourceKey, original: value, amount: value < 0n ? -value : value, allocatedBefore: 0n }];
  };
  const expectedSources = source("EXPECTED", expected), actualSources = source("ACTUAL", actual);
  const plan = reconciliationEvidencePlan(measure, { expected: expectedSources, actual: actualSources, evidence,
    reason: input.reason, varianceAction: movement ? `INVENTORY_STOCKTAKE_ADJUSTMENT:${movement.id}` : null });
  return { provider: "INVENTORY" as const, sourceType: "STOCKTAKE" as const, sourceId: observation.id,
    state: delta === 0n ? "MATCHED" as const : "OPEN_VARIANCE" as const, plan };
}
