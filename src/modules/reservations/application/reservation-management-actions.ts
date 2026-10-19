"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { reservationFormValues } from "../domain/reservation";
import { reservationActorContextFromSession } from "./reservation-access";
import { ReservationAuthorizationError, ReservationConflictError, ReservationNotFoundError } from "./reservation-service";
import { changeReservation, connectReservationFeed, createCalendarBlock, importReservationCsv, mergeReservationGuests, resolveReservationException, syncReservationFeed, updateReservationFeed, reviewMissingFeedEntry, releaseCalendarBlock } from "./reservation-management-service";

export type ManagementAction = "connect" | "sync" | "feed" | "import" | "change" | "block" | "resolve" | "merge" | "missing" | "release";
export type ManagementState = { status: "idle" | "success" | "error"; message?: "validation" | "forbidden" | "notFound" | "conflict" | "generic" | "syncFailed"; counts?: { imported: number; modified: number; duplicates: number } };
export async function reservationManagementAction(locale: string, kind: ManagementAction, _state: ManagementState, data: FormData): Promise<ManagementState> {
  const ctx = await reservationActorContextFromSession(await auth());
  if (!ctx) return { status: "error", message: "forbidden" };
  const values = reservationFormValues(data);
  if (kind === "feed") values.enabled = values.enabled === "true";
  let counts: ManagementState["counts"];
  let syncFailed = false;
  try {
    if (kind === "connect") await connectReservationFeed(ctx, values);
    else if (kind === "sync") { const result = await syncReservationFeed(ctx, String(values.feedId)); syncFailed = result.status === "FAILED"; }
    else if (kind === "feed") await updateReservationFeed(ctx, values);
    else if (kind === "import") { const result = await importReservationCsv(ctx, values); counts = { imported: result.imported, modified: result.modified, duplicates: result.duplicates }; }
    else if (kind === "change") await changeReservation(ctx, values);
    else if (kind === "block") await createCalendarBlock(ctx, values);
    else if (kind === "resolve") await resolveReservationException(ctx, values);
    else if (kind === "merge") await mergeReservationGuests(ctx, values);
    else if (kind === "missing") await reviewMissingFeedEntry(ctx, values);
    else if (kind === "release") await releaseCalendarBlock(ctx, values);
    else return { status: "error", message: "validation" };
  } catch (error) {
    const message = error instanceof z.ZodError ? "validation" : error instanceof ReservationAuthorizationError ? "forbidden" : error instanceof ReservationNotFoundError ? "notFound" : error instanceof ReservationConflictError ? "conflict" : "generic";
    return { status: "error", message };
  }
  for (const path of ["reservations", "reservations/calendar", "operations", ""]) revalidatePath(`/${safeLocale(locale)}/app/${path}`);
  if (typeof values.reservationId === "string") revalidatePath(`/${safeLocale(locale)}/app/reservations/${values.reservationId}`);
  if (syncFailed) return { status: "error", message: "syncFailed" };
  return { status: "success", counts };
}
