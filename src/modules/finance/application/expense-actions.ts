"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { createExpenseDraft,updateExpenseDraft, submitExpense, ExpenseAccessError, ExpenseConflictError, ExpenseConfigurationError } from "./expense-service";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { postExpense,voidExpense } from "./expense-posting-service";
import { AccountingPeriodClosedError } from "../domain/accounting-period";

async function run<T>(work: (actor: NonNullable<Awaited<ReturnType<typeof financeActorContextFromSession>>>) => Promise<T>) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new ExpenseAccessError();
    return { ok: true as const, data: await work(actor) };
  } catch (error) {
    const code: "forbidden" | "conflict" | "configuration" | "validation" | "periodClosed" | "error" = error instanceof AccountingPeriodClosedError ? "periodClosed" : error instanceof ExpenseAccessError ? "forbidden" : error instanceof ExpenseConflictError ? "conflict" :
      error instanceof ExpenseConfigurationError || error instanceof ExpensePolicyUnavailableError ? "configuration" : error instanceof z.ZodError ? "validation" : "error";
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "native-expense" } });
    return { ok: false as const, code };
  }
}
export async function createExpenseDraftAction(input: unknown) { return run(actor => createExpenseDraft(actor, input)); }
export async function updateExpenseDraftAction(input:unknown){
  return run(async actor=>{const result=await updateExpenseDraft(actor,input);revalidatePath("/[locale]/app/expenses/[id]","page");return result;});
}
export async function submitExpenseAction(input: unknown) {
  return run(async actor => { const result = await submitExpense(actor, input); revalidatePath("/[locale]/app/expenses/[id]", "page"); return result; });
}
export async function postExpenseAction(input:unknown){
  return run(async actor=>{const result=await postExpense(actor,input);revalidatePath("/[locale]/app/expenses/[id]","page");return result;});
}
export async function voidExpenseAction(input:unknown){
  return run(async actor=>{const result=await voidExpense(actor,input);revalidatePath("/[locale]/app/expenses/[id]","page");return result;});
}
