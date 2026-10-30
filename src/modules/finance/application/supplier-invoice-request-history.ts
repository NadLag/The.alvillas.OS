import { z } from "zod";
import type { SupplierInvoiceRecognitionRequestRepository } from "../infrastructure/supplier-invoice-recognition-request-repository";

export const supplierInvoiceFinancialStatusQuery = z.object({ id: z.uuid().transform(value => value.toLowerCase()), before: z.uuid().optional() }).strict();
const outcomeState = z.enum(["SUCCEEDED", "DENIED", "CONFLICT", "FAILED"]);
const failureCode = z.enum(["ACCESS_DENIED", "SOURCE_CHANGED", "PERIOD_CLOSED", "POLICY_UNAVAILABLE", "EXECUTION_UNAVAILABLE"]);

/** Present only the selected immutable public history fields; caps and canonical nonces stay in the repository. */
export function supplierInvoiceRequestHistory(history: Awaited<ReturnType<SupplierInvoiceRecognitionRequestRepository["history"]>>) {
  return { history: history.slice(0, 50).map(request => ({ id: request.id, reason: request.reason, requestedAt: request.requestedAt.toISOString(), currentPeriod: request.currentPeriod,
    state: request.outcome ? outcomeState.parse(request.outcome.state) : "PENDING" as const,
    completedAt: request.outcome?.occurredAt.toISOString() ?? null,
    failureCode: request.outcome?.failureCode ? failureCode.parse(request.outcome.failureCode) : null })),
    next: history.length > 50 ? history[49].id : null };
}
