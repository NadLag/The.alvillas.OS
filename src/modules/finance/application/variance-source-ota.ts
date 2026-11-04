import { z } from "zod";
import { Money } from "@/platform/money/money";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { VarianceWorkflowRepository } from "../infrastructure/variance-workflow-repository";
import { VarianceWorkflowSourceError } from "../domain/variance-workflow";
import { recheckFinanceAuthorization } from "./finance-access";
import type { VarianceSourceAuthority } from "./variance-workflow-service";

/** Authorize every original journal independently; assigning a case grants no source access. */
export const authorizeOtaVarianceSource: VarianceSourceAuthority = async (ctx, reference, tx, access) => {
  if (reference.provider !== "OTA") throw new VarianceWorkflowSourceError();
  const repository = new VarianceWorkflowRepository(tx, ctx.organizationId), finance = new FinanceRepository(tx, ctx.organizationId);
  const original = await repository.originalVariance(reference.id);
  if (!original) throw new VarianceWorkflowSourceError();
  const settlement = await finance.findAirbnbSettlement(original.sourceId);
  if (!settlement || settlement.propertyId !== original.propertyId || settlement.reservationId !== original.reservationId) throw new VarianceWorkflowSourceError();
  const journals = await finance.findPostingTransactionsForAirbnbSettlement(settlement.id);
  if (!journals.length || journals.some(journal => !journal.sealed)) throw new VarianceWorkflowSourceError();
  type Check = Parameters<typeof recheckFinanceAuthorization>[3][number];
  const checks: Check[] = [];
  for (const journal of journals) {
    const exposures = new Map<string, Money>();
    for (const posting of journal.postings.filter(posting => posting.side === "DEBIT")) exposures.set(posting.currency,
      (exposures.get(posting.currency) ?? Money.zero(posting.currency)).add(Money.of(posting.amount.toString(), posting.currency)));
    if (!exposures.size) throw new VarianceWorkflowSourceError();
    for (const exposure of exposures.values()) for (const entry of [journal, ...journal.reversedByTransactions]) {
      const resource = { type: "financial_transaction", organizationId: ctx.organizationId, id: entry.id, financialRecordId: entry.id,
        propertyId: original.propertyId ?? undefined, reservationId: original.reservationId ?? undefined, assignedUserAccountId: entry.createdBy ?? undefined,
        occurredAt: entry.occurredAt, amount: exposure.toJSON().amount, dataClass: "financial" as const };
      checks.push({ action: "view", resource });
      if (access !== "view" && access !== "history") checks.push({ action: "reconcile", resource });
      if (access === "ASSIGN") checks.push({ action: "assign", resource });
      if (access === "history") checks.push({ action: "view", resource: { ...resource, type: "audit_log" } });
    }
  }
  const recheck = async () => recheckFinanceAuthorization(ctx, tx, await finance.clock(), checks, new VarianceWorkflowSourceError());
  await recheck();
  const expected = Money.of(original.expectedAmount.toString(), original.currency), actual = Money.of(original.actualAmount.toString(), original.currency);
  return { baseline: { status: z.enum(["OPEN", "RESOLVED"]).parse(original.status), assignedTo: original.assignedTo,
      resolvedBy: original.resolvedBy, resolvedAt: original.resolvedAt?.toISOString() ?? null },
    facts: { kind: "MONEY", unit: "MONEY:" + original.currency, currency: original.currency,
      expected: expected.toJSON().amount, actual: actual.toJSON().amount, variance: actual.subtract(expected).toJSON().amount }, recheck };
};
