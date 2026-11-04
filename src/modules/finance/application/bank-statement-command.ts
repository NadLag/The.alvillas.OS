import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { bankStatementImportInput, bankStatementRecoveryInput, BankStatementMissingError, BankStatementAccessError } from "../domain/bank-statement";
import { bankStatementCommandReceiptSchema, bankStatementCommandRecoverySchema } from "../domain/bank-statement-command";
import { BankStatementRepository } from "../infrastructure/bank-statement-repository";
import { importBankStatement, recoverBankStatement } from "./bank-statement-import";
import type { FinanceActorContext } from "./finance-access";
type Deps = Parameters<typeof importBankStatement>[3];
const original = z.discriminatedUnion("state", [
  z.object({ state: z.literal("IMPORTED"), accountId: z.uuid(), admissionId: z.uuid(), importId: z.uuid(), rowCount: z.number().int().nonnegative(), newRows: z.number().int().nonnegative(), reusedRows: z.number().int().nonnegative() }).strict(),
  z.object({ state: z.literal("ADMITTED"), accountId: z.uuid(), admissionId: z.uuid(), importId: z.null(), rowCount: z.null(), resumeInput: bankStatementImportInput }).strict()
]);
function receipt(raw: unknown, idempotencyKey: string) {
  const source = original.parse(raw), base = { requestId: source.admissionId, idempotencyKey, operation: "IMPORT", failureCode: null };
  return bankStatementCommandReceiptSchema.parse(source.state === "IMPORTED" ? { ...base, state: "SUCCEEDED", accountId: source.accountId, importId: source.importId, rowCount: source.rowCount, newRows: source.newRows, reusedRows: source.reusedRows } : { ...base, state: "PENDING", resumeInput: source.resumeInput });
}
export async function requestBankStatementCommand(context: FinanceActorContext, raw: unknown, bytes: Uint8Array, deps: Deps = {}) {
  const input = bankStatementImportInput.parse(raw);
  return receipt(await importBankStatement(context, input, bytes, deps), input.idempotencyKey);
}
export async function recoverBankStatementCommand(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = bankStatementRecoveryInput.parse(raw);
  try { return bankStatementCommandRecoverySchema.parse({ request: receipt(await recoverBankStatement(context, input, deps), input.idempotencyKey) }); }
  catch (error) { if (error instanceof BankStatementMissingError) return bankStatementCommandRecoverySchema.parse({ request: null }); throw error; }
}
export async function bankStatementCommandStatus(context: FinanceActorContext, raw: unknown, deps: Deps = {}) {
  const input = z.object({ id: z.uuid() }).strict().parse(raw), ctx = { ...context, authContext: restoreAuthorizationCap(captureAuthorizationCap(context.authContext)) };
  const source = await withTenant(deps.db ?? prisma, ctx.organizationId, tx => new BankStatementRepository(tx, ctx.organizationId).admissionById(ctx.actorId, input.id));
  if (!source) throw new BankStatementAccessError();
  const result = await recoverBankStatementCommand(ctx, { idempotencyKey: source.idempotencyKey }, deps);
  if (!result.request || result.request.requestId !== input.id) throw new BankStatementAccessError();
  return result.request;
}
