"use server";

import { randomUUID } from "node:crypto";
import { logger } from "@/platform/observability/logger";
import { revalidatePath } from "next/cache";
import { z, ZodError } from "zod";
import { routing } from "@/i18n/routing";
import { PersonalTransferRepository } from "../infrastructure/personal-transfer-repository";
import { PersonalDocumentRepository } from "../infrastructure/personal-document-repository";
import { financeKindSchema } from "../domain/personal-finance";
import {
  HouseholdRepository, PersonalAccessDenied, PersonalConflict, PersonalFinanceRepository, personalIdentity, personalSession
} from "./personal-session";

const commands = z.enum(["member", "revoke", "finance", "reverse", "upload", "archive", "restore", "requestTransfer", "confirmTransfer", "cancelTransfer"]);
const target = z.object({ locale: z.enum(routing.locales), householdId: z.uuid(), command: commands });
type ActionState = { status: "idle" | "saved" | "invalid" | "unavailable" | "denied" };

function optional(form: FormData, key: string) {
  return form.get(key) || undefined;
}

export async function mutatePersonal(
  rawTarget: z.infer<typeof target>, _previous: ActionState, form: FormData
): Promise<ActionState> {
  const data = target.safeParse(rawTarget);
  if (!data.success) return { status: "invalid" };
  const { locale, householdId, command } = data.data;
  const identity = personalIdentity(await personalSession());
  if (!identity) return { status: "denied" };

  try {
    await new HouseholdRepository().scoped(identity, householdId, async (scope) => {
      switch (command) {
        case "member":
          return scope.setMember({
            accountId: form.get("accountId"), displayName: form.get("displayName"),
            isChild: form.get("isChild") === "on", grants: form.getAll("grant")
          });
        case "revoke":
          return scope.revokeMember(z.uuid().parse(form.get("accountId")));
        case "finance":
          return new PersonalFinanceRepository(scope).record({
            id: form.get("id"), kind: form.get("kind"), label: form.get("label"),
            category: form.get("category"), amount: form.get("amount"), currency: form.get("currency"),
            effectiveOn: form.get("effectiveOn"), seriesId: optional(form, "seriesId"), goalId: optional(form, "goalId"),
            withdrawal: form.get("withdrawal") === "on", closed: form.get("closed") === "on"
          });
        case "requestTransfer":
          return new PersonalTransferRepository(scope).request({
            id: form.get("id"), category: form.get("category"), direction: form.get("direction"),
            amount: form.get("amount"), currency: form.get("currency"), effectiveOn: form.get("effectiveOn")
          });
        case "confirmTransfer":
          return new PersonalTransferRepository(scope).confirm({
            id: form.get("id"), businessTransactionId: form.get("businessTransactionId")
          });
        case "cancelTransfer":
          return new PersonalTransferRepository(scope).cancel(z.uuid().parse(form.get("id")));
        case "upload":
          return new PersonalDocumentRepository(scope).upload({
            id: form.get("id"), displayName: form.get("displayName"), file: form.get("file")
          });
        case "archive":
        case "restore":
          return new PersonalDocumentRepository(scope).archive(z.uuid().parse(form.get("id")), command === "archive");
        case "reverse":
          return new PersonalFinanceRepository(scope).reverse(financeKindSchema.parse(form.get("kind")), {
            id: form.get("id"), sourceId: form.get("sourceId"), reason: form.get("reason")
          });
      }
    });
    revalidatePath(`/${locale}/personal/${householdId}`, "layout");
    return { status: "saved" };
  } catch (error) {
    if (error instanceof ZodError || error instanceof PersonalConflict) return { status: "invalid" };
    if (error instanceof PersonalAccessDenied) return { status: "denied" };
    logger.error("personal.command_failed", { organizationId: identity.organizationId, requestId: randomUUID() }, { command });
    return { status: "unavailable" };
  }
}
