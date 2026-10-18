"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { captureException } from "@/platform/observability/sentry";
import { IdentityAuthorizationError } from "./identity-access";
import { IdentityConflictError } from "./identity-service";
import {
  teamActorContextFromSession,
  saveTeamProfile,
  assignTeamRole,
  retireTeamRole,
  saveTeamCompensation,
  requestTeamAvailability,
  decideTeamAvailability,
  linkTeamWallet,
  offboardTeamMember,
  TeamConflictError,
  TeamNotFoundError
} from "./team-service";
import { uploadTeamDocument, archiveTeamDocument } from "./team-documents";
import { parseTeamForm, teamOperations } from "../domain/team";

export type TeamActionState = {
  status: "idle" | "saved" | "invalid" | "denied" | "conflict" | "unavailable";
  id?: string;
};
export async function teamMutationAction(
  locale: string,
  operation: string,
  _previous: TeamActionState,
  data: FormData
): Promise<TeamActionState> {
  const ctx = await teamActorContextFromSession(await auth());
  if (!ctx) return { status: "denied" };
  try {
    const command = teamOperations.parse(operation);
    const input = parseTeamForm(command, data);
    const deps = { requestId: randomUUID() };
    let result: { id: string } | void;
    switch (command) {
      case "profile":
        result = await saveTeamProfile(ctx, input, deps);
        break;
      case "assignment":
        result = await assignTeamRole(ctx, input, deps);
        break;
      case "retire":
        result = await retireTeamRole(ctx, input, deps);
        break;
      case "compensation":
        result = await saveTeamCompensation(ctx, input, deps);
        break;
      case "availability":
        result = await requestTeamAvailability(ctx, input, deps);
        break;
      case "decision":
        result = await decideTeamAvailability(ctx, input, deps);
        break;
      case "wallet":
        result = await linkTeamWallet(ctx, input, deps);
        break;
      case "offboard":
        result = await offboardTeamMember(ctx, input, deps);
        break;
      case "archive_document":
        result = await archiveTeamDocument(ctx, input, deps);
        break;
      case "document": {
        const file = data.get("file");
        if (!(file instanceof File) || file.size > 4000000) return { status: "invalid" };
        result = await uploadTeamDocument(ctx, input, new Uint8Array(await file.arrayBuffer()), deps);
        break;
      }
    }
    revalidatePath(`/${safeLocale(locale)}/app/team`);
    revalidatePath(`/${safeLocale(locale)}/app/team/[personId]`, "page");
    return { status: "saved", id: result?.id };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: "invalid" };
    if (error instanceof IdentityAuthorizationError || error instanceof TeamNotFoundError)
      return { status: "denied" };
    if (error instanceof TeamConflictError || error instanceof IdentityConflictError)
      return { status: "conflict" };
    // Database constraints are authoritative for concurrent decisions and assignment conflicts.
    if (
      error instanceof Error &&
      /team .*conflict|team .*overlap|team .*clear tasks|Unique constraint/iu.test(error.message)
    )
      return { status: "conflict" };
    await captureException(new Error("team_mutation_failed"), {
      source: "api",
      organizationId: ctx.organizationId
    });
    return { status: "unavailable" };
  }
}
