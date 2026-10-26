"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession, type FinanceActorContext } from "./finance-access";
import { createTransactionGroup, changeTransactionGroupMembership, TransactionGroupAccessError, TransactionGroupConflictError } from "./transaction-group-service";

async function execute(input: unknown, operation: (ctx: FinanceActorContext, input: unknown, deps: { requestId: string }) => Promise<{ id: string }>) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new TransactionGroupAccessError();
    const data = await operation(actor, input, { requestId });
    revalidatePath("/[locale]/app/finance/groups", "page");
    revalidatePath("/[locale]/app/finance/groups/[groupId]", "page");
    return { ok: true as const, data };
  } catch (error) {
    const code = error instanceof TransactionGroupAccessError ? "forbidden" as const : error instanceof TransactionGroupConflictError ? "conflict" as const :
      error instanceof z.ZodError ? "validation" as const : "error" as const;
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "transaction-group" } });
    return { ok: false as const, code };
  }
}
export async function createTransactionGroupAction(input: unknown) { return execute(input, createTransactionGroup); }
export async function changeTransactionGroupMembershipAction(input: unknown) { return execute(input, changeTransactionGroupMembership); }
