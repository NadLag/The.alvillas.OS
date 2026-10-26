"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { financeActorContextFromSession } from "./finance-access";
import { createPaymentAccount, PaymentAccountAccessError, PaymentAccountConflictError } from "./payment-account-service";

export async function createPaymentAccountAction(input: unknown) {
  const requestId = crypto.randomUUID();
  try {
    const actor = await financeActorContextFromSession(await auth());
    if (!actor) throw new PaymentAccountAccessError();
    const data = await createPaymentAccount(actor, input, { requestId });
    revalidatePath("/[locale]/app/finance/accounts", "page");
    return { ok: true as const, data };
  } catch (error) {
    const code = error instanceof PaymentAccountAccessError ? "forbidden" as const : error instanceof PaymentAccountConflictError ? "conflict" as const :
      error instanceof z.ZodError ? "validation" as const : "error" as const;
    if (code === "error") await captureException(error, { source: "api", requestId, tags: { feature: "payment-account" } });
    return { ok: false as const, code };
  }
}
