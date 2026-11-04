import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { bankReconciliationCommandInput, bankReconciliationCommandReceiptSchema, bankReconciliationCommandRecoverySchema, bankReconciliationResultSchema } from "../domain/bank-reconciliation-command";
import { bankReconciliationRecoveryInput, BankReconciliationAccessError, BankReconciliationMissingError } from "../domain/bank-reconciliation";
import { BankReconciliationRepository } from "../infrastructure/bank-reconciliation-repository";
import { matchBankStatement, releaseBankReconciliation, recoverBankReconciliation } from "./bank-reconciliation-service";
import type { FinanceActorContext } from "./finance-access";

type Deps = Parameters<typeof matchBankStatement>[2];
const receipt = (raw: unknown, idempotencyKey: string) => {
  const result = bankReconciliationResultSchema.parse(raw);
  return bankReconciliationCommandReceiptSchema.parse({ requestId: result.id, idempotencyKey, operation: result.action, state: "SUCCEEDED", failureCode: null, result });
};
export async function requestBankReconciliationCommand(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = bankReconciliationCommandInput.parse(raw);
  return receipt(await (input.action === "MATCH" ? matchBankStatement(context, input, deps) : releaseBankReconciliation(context, input, deps)), input.idempotencyKey);
}
export async function recoverBankReconciliationCommand(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = bankReconciliationRecoveryInput.parse(raw);
  try { return bankReconciliationCommandRecoverySchema.parse({ request: receipt(await recoverBankReconciliation(context, input, deps), input.idempotencyKey) }); }
  catch (error) { if (error instanceof BankReconciliationMissingError) return bankReconciliationCommandRecoverySchema.parse({ request: null }); throw error; }
}
export async function bankReconciliationCommandStatus(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = z.object({ id: z.uuid() }).strict().parse(raw), ctx = { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) };
  const original = await withTenant(deps.db ?? prisma, ctx.organizationId, tx => new BankReconciliationRepository(tx, ctx.organizationId).requestKey(ctx.actorId, input.id));
  if (!original) throw new BankReconciliationAccessError();
  const recovered = await recoverBankReconciliationCommand(ctx, { idempotencyKey: original.idempotencyKey }, deps);
  if (!recovered.request || recovered.request.requestId !== input.id) throw new BankReconciliationAccessError();
  return recovered.request;
}
