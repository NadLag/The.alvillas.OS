import { z } from "zod";
import { authorize, type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import type { FinanceActorContext } from "./finance-access";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { paymentAccountCode, paymentAccountSchema } from "../domain/payment-account";

type Deps = { db?: TenantTransactionRunner; requestId?: string };
export class PaymentAccountAccessError extends Error {}
export class PaymentAccountConflictError extends Error {}
const filters = z.object({ after: z.uuid().optional(), query: z.string().trim().max(120).optional() }).strict();
const chartResource = (organizationId: string): Resource => ({ type: "financial_transaction", organizationId, dataClass: "financial" });

async function current(ctx: FinanceActorContext, tx: TenantTransaction) {
  if (ctx.organizationId !== ctx.authContext.organizationId || ctx.actorId !== ctx.authContext.userAccountId) throw new PaymentAccountAccessError();
  return authContextForAccountInTransaction(tx, ctx.organizationId, ctx.actorId);
}

export async function listPaymentAccounts(ctx: FinanceActorContext, raw: unknown = {}, deps: Deps = {}) {
  const input = filters.parse(raw);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new FinanceRepository(tx, ctx.organizationId), now = await repository.clock();
    const authContext = await current(ctx, tx), resource = chartResource(ctx.organizationId);
    // The company chart is organization-wide; property, employee-wallet and
    // amount-limited grants do not confer access to this collection.
    if (!authorize(authContext, "view", resource, now)) throw new PaymentAccountAccessError();
    const rows = await repository.listLedgerAccounts({ ...input, take: 51 });
    const accounts = rows.slice(0, 50);
    return { accounts, next: rows.length > 50 ? accounts.at(-1)?.id : undefined,
      canConfigure: authorize(authContext, "configure", resource, now) };
  });
}

export async function createPaymentAccount(ctx: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = paymentAccountSchema.parse(raw), code = paymentAccountCode(input);
  return withTenant(deps.db ?? prisma, ctx.organizationId, async tx => {
    const repository = new FinanceRepository(tx, ctx.organizationId), now = await repository.lockPaymentAccount(input.idempotencyKey);
    const authContext = await current(ctx, tx), resource = chartResource(ctx.organizationId);
    if (!authorize(authContext, "view", resource, now) || !authorize(authContext, "configure", resource, now)) throw new PaymentAccountAccessError();
    const matches = await repository.paymentAccountsByKey(input.idempotencyKey);
    if (matches.length > 1) throw new PaymentAccountConflictError();
    const existing = matches[0];
    if (existing) {
      const audit = await repository.ledgerAccountCreationAudit(existing.id), after = audit?.after;
      if (existing.code !== code || existing.name !== input.name || existing.accountType !== "ASSET_LOCATION" || existing.normalSide !== "DEBIT" || existing.archivedAt ||
        audit?.actorId !== ctx.actorId || audit.reason !== input.reason || !after || typeof after !== "object" || Array.isArray(after) || after.kind !== input.kind)
        throw new PaymentAccountConflictError();
      return { id: existing.id };
    }
    const account = await repository.ensureLedgerAccount({ code, name: input.name, accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    await writeAuditEvent(tx, { organizationId: ctx.organizationId, actorId: ctx.actorId, action: "finance.account.created",
      resourceType: "ledger_account", resourceId: account.id, after: { accountId: account.id, code, name: account.name,
        kind: input.kind, accountType: account.accountType, normalSide: account.normalSide }, reason: input.reason,
      requestId: deps.requestId ?? crypto.randomUUID(), occurredAt: now });
    return { id: account.id };
  });
}
