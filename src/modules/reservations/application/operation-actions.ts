"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { setRequestLocale } from "next-intl/server";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { reservationActorContextFromSession } from "./reservation-access";
import {
  createOperationTask,
  proxyCompleteOperationTask,
  transitionOperationTask,
} from "./operation-service";
import {
  ReservationAuthorizationError,
  ReservationConflictError,
  ReservationConfigError,
  ReservationNotFoundError,
} from "./reservation-service";
import { captureException } from "@/platform/observability/sentry";
import {
  parseOperationForm,
  type OperationFormOperation,
} from "../domain/operation-task";
import {
  assignOperationTask,
  rescheduleOperationTask,
  swapOperationTasks,
} from "./operation-scheduling";
import {
  archiveOperationView,
  bulkOperationTasks,
  saveOperationView,
} from "./operation-management";
import {
  generateRecurringOperations,
  saveOperationSeries,
} from "./operation-automation";
import {
  attachOperationEvidence,
  reportOperationIssue,
  saveOperationProgress,
} from "./operation-evidence";

export type OperationFormState = {
  status: "idle" | "saved" | "error";
  generation?: { created: number; existing: number; more: boolean };
  message?:
    | "validation"
    | "forbidden"
    | "conflict"
    | "config"
    | "notFound"
    | "generic";
};
export async function operationAction(
  locale: string,
  operation: OperationFormOperation,
  _state: OperationFormState,
  form: FormData,
): Promise<OperationFormState> {
  setRequestLocale(safeLocale(locale));
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx) return { status: "error", message: "forbidden" };
  let createdId: string | undefined;
  let generation: OperationFormState["generation"];
  try {
    const value = parseOperationForm(operation, form);
    if (operation === "create") {
      const created = await createOperationTask(ctx, value);
      createdId = created.id;
    } else if (operation === "transition")
      await transitionOperationTask(ctx, value);
    else if (operation === "proxy")
      await proxyCompleteOperationTask(ctx, value);
    else if (operation === "assign") await assignOperationTask(ctx, value);
    else if (operation === "reschedule")
      await rescheduleOperationTask(ctx, value);
    else if (operation === "swap") await swapOperationTasks(ctx, value);
    else if (operation === "bulk") await bulkOperationTasks(ctx, value);
    else if (operation === "save_view") await saveOperationView(ctx, value);
    else if (operation === "archive_view")
      await archiveOperationView(
        ctx,
        z.object({ id: z.uuid() }).parse(value).id,
      );
    else if (operation === "recurring")
      generation = await generateRecurringOperations(ctx, value);
    else if (operation === "evidence") {
      const file = form.get("file") as File | null;
      await attachOperationEvidence(
        ctx,
        value,
        file?.size ? new Uint8Array(await file.arrayBuffer()) : undefined,
      );
    } else if (operation === "issue") await reportOperationIssue(ctx, value);
    else if (operation === "progress") await saveOperationProgress(ctx, value);
    else if (operation === "series") await saveOperationSeries(ctx, value);
    else throw new ReservationAuthorizationError();
  } catch (error) {
    if (error instanceof z.ZodError)
      return { status: "error", message: "validation" };
    if (error instanceof ReservationAuthorizationError)
      return { status: "error", message: "forbidden" };
    if (error instanceof ReservationConflictError)
      return { status: "error", message: "conflict" };
    if (error instanceof ReservationNotFoundError)
      return { status: "error", message: "notFound" };
    if (error instanceof ReservationConfigError)
      return { status: "error", message: "config" };
    void captureException(error, {
      source: "next",
      organizationId: ctx.organizationId,
      tags: { operation },
    });
    return { status: "error", message: "generic" };
  }
  revalidatePath(`/${safeLocale(locale)}/app/operations`);
  revalidatePath(`/${safeLocale(locale)}/app/field`);
  revalidatePath(`/${safeLocale(locale)}/app/operations/recurring`);
  const taskId = form.get("taskId");
  if (typeof taskId === "string" && z.uuid().safeParse(taskId).success) {
    revalidatePath(`/${safeLocale(locale)}/app/operations/${taskId}`);
    revalidatePath(`/${safeLocale(locale)}/app/field/${taskId}`);
  }
  if (createdId) redirect(`/${safeLocale(locale)}/app/operations/${createdId}`);
  return { status: "saved", generation };
}
