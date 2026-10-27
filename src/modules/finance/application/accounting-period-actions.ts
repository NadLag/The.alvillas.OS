"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession, type FinanceActorContext } from "./finance-access";
import { closeAccountingPeriod, reopenAccountingPeriod } from "./accounting-period-service";
import { AccountingPeriodAccessError, AccountingPeriodConflictError, AccountingPeriodPolicyError } from "../domain/accounting-period";

async function execute(raw: unknown, operation: (actor: FinanceActorContext, input: unknown, deps: { requestId: string }) => Promise<{ id: string }>) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth()); if (!actor) throw new AccountingPeriodAccessError();
    const data = await operation(actor, raw, { requestId });
    revalidatePath("/[locale]/app/finance/periods", "page"); revalidatePath("/[locale]/app/finance/periods/[periodId]", "page");
    return { ok: true as const, data };
  } catch (error) {
    const code = error instanceof AccountingPeriodAccessError ? "forbidden" as const : error instanceof AccountingPeriodConflictError ? "conflict" as const :
      error instanceof z.ZodError ? "validation" as const : error instanceof AccountingPeriodPolicyError ? error.code : "error" as const;
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "accounting-period" } });
    return { ok: false as const, code };
  }
}
export async function closeAccountingPeriodAction(input: unknown) { return execute(input, closeAccountingPeriod); }
export async function reopenAccountingPeriodAction(input: unknown) { return execute(input, reopenAccountingPeriod); }
