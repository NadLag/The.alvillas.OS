import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransactionRunner } from "@/platform/db/tenant";
import { encryptSecret, decryptSecret } from "@/platform/auth/secret-encryption";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { ExternalPaymentRefundError } from "../domain/external-payment-refund-intent";
import { GuestDepositAuthorizationError } from "../domain/guest-deposit";
import { externalRefundSupervisionListInput, externalRefundSupervisionListSchema } from "../domain/external-payment-refund-supervision-workspace";
import { ExternalPaymentRefundRepository } from "../infrastructure/external-payment-refund-repository";
import { GuestDepositRepository } from "../infrastructure/guest-deposit-repository";
import { externalPaymentContext } from "./external-payment-service";
import { inspectExternalRefundForSupervision } from "./external-payment-refund-supervision";
import { readGuestDepositSourceInTransaction, presentGuestDepositResult } from "./guest-deposit-service";
import type { FinanceActorContext } from "./finance-access";

const boundary = z.object({ purpose: z.literal("external-refund-supervision.v1"), organizationId: z.uuid(), actorId: z.uuid(), depositId: z.uuid(), after: z.uuid() }).strict();
export async function listExternalRefundsForSupervision(inputContext: FinanceActorContext, raw: unknown, deps: { db?: TenantTransactionRunner; requestId?: string } = {}) {
  const ctx = externalPaymentContext(inputContext), input = externalRefundSupervisionListInput.parse(raw); let after: string | undefined;
  if (input.after) {
    try { const value = boundary.parse(JSON.parse(decryptSecret(input.after))); if (value.organizationId !== ctx.organizationId || value.actorId !== ctx.actorId || value.depositId !== input.depositId) throw new ExternalPaymentRefundError(); after = value.after; }
    catch { throw new ExternalPaymentRefundError(); }
  }
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const source = await readGuestDepositSourceInTransaction(ctx, input.depositId, tx), repository = new ExternalPaymentRefundRepository(tx, ctx.organizationId), native = new GuestDepositRepository(tx, ctx.organizationId),
      rows = await repository.supervisionCandidates(input.depositId, ctx.actorId, after), retained = [] as Array<{ request: typeof rows[number]; fingerprint: string }>, items = [];
    for (const request of rows.slice(0, 50)) {
      if (request.identity?.observations[0]?.state !== "COMPLETED" || !request.identity.observations[0].settlement || await native.byCommand(request.idempotencyKey)) continue;
      try {
        const inspected = await inspectExternalRefundForSupervision(ctx, tx, request); retained.push({ request, fingerprint: inspected.fingerprint });
        items.push({ intentId: request.id, refundId: request.identity.refundId, originalRequestedBy: request.requestedBy, amount: inspected.verified.settlement.gross,
          returnedFee: inspected.verified.settlement.fee, refundedAt: inspected.refundedAt.toISOString() });
      } catch (error) { if (!(error instanceof ExternalPaymentRefundError || error instanceof GuestDepositAuthorizationError)) throw error; }
    }
    const next = rows.length > 50 ? encryptSecret(JSON.stringify({ purpose: "external-refund-supervision.v1", organizationId: ctx.organizationId, actorId: ctx.actorId, depositId: input.depositId, after: rows[49].id })) : null;
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.external_payment.refund_supervision_sources_viewed", resourceType: "financial_transaction", resourceId: source.row.id,
      propertyScopeId: source.resource.propertyId, after: { depositId: input.depositId }, reason: "Viewed independently scoped original paid refunds awaiting financial admission", requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: await source.finance.clock() });
    await readGuestDepositSourceInTransaction(ctx, input.depositId, tx);
    for (const item of retained) { const current = await repository.find(item.request.id); if (!current || (await inspectExternalRefundForSupervision(ctx, tx, current)).fingerprint !== item.fingerprint) throw new ExternalPaymentRefundError(); }
    return presentGuestDepositResult(ctx, source.resource, externalRefundSupervisionListSchema.parse({ items, next }), await source.finance.clock());
  });
}
