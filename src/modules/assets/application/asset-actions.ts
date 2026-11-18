"use server";

import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { accountActorContextFromSession } from "@/platform/authz/session-context";
import { AssetAccessError, AssetConflictError } from "../domain/asset";
import { saveAsset } from "./asset-service";

export async function saveAssetAction(input: unknown) {
  const actor = await accountActorContextFromSession(await auth());
  if (!actor) return { ok: false as const, code: "forbidden" as const };
  try { return { ok: true as const, asset: await saveAsset(actor, input) }; }
  catch (error) {
    if (error instanceof z.ZodError) return { ok: false as const, code: "invalid" as const };
    if (error instanceof AssetAccessError) return { ok: false as const, code: "forbidden" as const };
    if (error instanceof AssetConflictError) return { ok: false as const, code: "conflict" as const };
    throw error;
  }
}
