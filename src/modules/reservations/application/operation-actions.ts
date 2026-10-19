"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { reservationActorContextFromSession } from "./reservation-access";
import { createOperationTask, proxyCompleteOperationTask, transitionOperationTask } from "./operation-service";
import { ReservationAuthorizationError, ReservationConflictError, ReservationConfigError, ReservationNotFoundError } from "./reservation-service";
import { captureException } from "@/platform/observability/sentry";
import { parseOperationForm } from "../domain/operation-task";

export type OperationFormState = { status: "idle" | "saved" | "error"; message?: "validation" | "forbidden" | "conflict" | "config" | "notFound" | "generic" };
export async function operationAction(locale: string, operation: "create" | "transition" | "proxy", _state: OperationFormState, form: FormData): Promise<OperationFormState> {
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx) return { status: "error", message: "forbidden" };
  let createdId: string | undefined;
  try {
    const value = parseOperationForm(operation, form);
    if (operation === "create") {
      const created = await createOperationTask(ctx, value);
      createdId = created.id;
    } else if (operation === "transition") await transitionOperationTask(ctx, value);
    else if (operation === "proxy") await proxyCompleteOperationTask(ctx, value);
    else throw new ReservationAuthorizationError();
  } catch (error) {
    if (error instanceof z.ZodError) return { status: "error", message: "validation" };
    if (error instanceof ReservationAuthorizationError) return { status: "error", message: "forbidden" };
    if (error instanceof ReservationConflictError) return { status: "error", message: "conflict" };
    if (error instanceof ReservationNotFoundError) return { status: "error", message: "notFound" };
    if (error instanceof ReservationConfigError) return { status: "error", message: "config" };
    void captureException(error, { source: "next", organizationId: ctx.organizationId, tags: { operation } });
    return { status: "error", message: "generic" };
  }
  revalidatePath(`/${safeLocale(locale)}/app/operations`);
  revalidatePath(`/${safeLocale(locale)}/app/field`);
  if (createdId) redirect(`/${safeLocale(locale)}/app/operations/${createdId}`);
  return { status: "saved" };
}
