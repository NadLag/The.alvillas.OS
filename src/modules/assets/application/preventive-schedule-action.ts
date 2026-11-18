"use server";

import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { ReservationAuthorizationError, ReservationConflictError } from "@/platform/reservations/asset-preventive-operations";
import { AssetAccessError, AssetConflictError } from "../domain/asset";
import { saveAssetPreventiveSchedule } from "./preventive-schedule";

export async function saveAssetPreventiveScheduleAction(input: unknown) {
  const actor = await accountActorContextFromSession(await auth());
  if (!actor) return "forbidden";
  try {
    await saveAssetPreventiveSchedule(actor, input);
    return "saved";
  } catch (error) {
    if (error instanceof z.ZodError) return "invalid";
    if (error instanceof AssetAccessError || error instanceof ReservationAuthorizationError) return "forbidden";
    if (error instanceof AssetConflictError || error instanceof ReservationConflictError) return "conflict";
    throw error;
  }
}
