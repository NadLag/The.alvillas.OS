import { createHash } from "node:crypto";
import type { FinancePostingDraft } from "./reservation-revenue";
import { assertFinancePostingsBalanced } from "./reservation-revenue";
import type { Money } from "@/platform/money/money";

export function cashCollectionRevision(taskId: string, taskVersion: number, count: bigint): string {
  return createHash("sha256").update(JSON.stringify([taskId, taskVersion, count.toString()])).digest("base64url");
}

/** Handbook G.3(9): collection changes custody; service allocation happens separately. */
export function cashCollectionPostings(input: {
  amount: Money; custodyAccountId: string; unallocatedAccountId: string; dimensions: Record<string, unknown>;
}): FinancePostingDraft[] {
  if (!input.amount.amount.gt(0) || input.custodyAccountId === input.unallocatedAccountId) throw new Error("Invalid cash custody journal");
  const postings: FinancePostingDraft[] = [
    { ledgerAccountId: input.custodyAccountId, side: "DEBIT", amount: input.amount, bucket: "CASH_COLLECTION", dimensions: input.dimensions },
    { ledgerAccountId: input.unallocatedAccountId, side: "CREDIT", amount: input.amount, bucket: "UNALLOCATED_COLLECTION", dimensions: input.dimensions }
  ];
  assertFinancePostingsBalanced(postings); return postings;
}
