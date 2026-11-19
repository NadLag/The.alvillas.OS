"use server";

import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { AssetAccessError, AssetConflictError } from "../domain/asset";
import { recordAssetLifecycle } from "./asset-lifecycle";

export async function recordAssetLifecycleAction(input: unknown) {
  const actor = await accountActorContextFromSession(await auth());
  if (!actor) return "forbidden";
  try {
    await recordAssetLifecycle(actor, input);
    return "saved";
  } catch (error) {
    if (error instanceof z.ZodError) return "invalid";
    if (error instanceof AssetAccessError) return "forbidden";
    if (error instanceof AssetConflictError) return "conflict";
    throw error;
  }
}
