import { z } from "zod";

const receipt = z.object({ originalTransactionIds: z.array(z.uuid()), reversalTransactionIds: z.array(z.uuid()) });
function sameIds(a: string[], b: string[]): boolean {
  const left = [...a].sort(), right = [...b].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function matchesFinancialReversalAttempt(input: {
  actorId: string; reason: string; originalIds: string[];
  reversals: Array<{ id: string; createdBy: string | null; reversesTransactionId: string | null }>;
  audit: { actorId: string | null; reason: string | null; after: unknown } | null;
}): boolean {
  const after = receipt.safeParse(input.audit?.after);
  return Boolean(input.audit && after.success && input.audit.actorId === input.actorId && input.audit.reason === input.reason &&
    input.reversals.every(row => row.createdBy === input.actorId && row.reversesTransactionId !== null) &&
    sameIds(input.originalIds, input.reversals.map(row => row.reversesTransactionId!)) &&
    sameIds(input.originalIds, after.data.originalTransactionIds) && sameIds(input.reversals.map(row => row.id), after.data.reversalTransactionIds));
}
