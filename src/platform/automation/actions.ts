"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/platform/auth/session";
import { reservationActorContextFromSession } from "@/modules/reservations/application/reservation-access";
import {
  changeAutomationState,
  previewAutomation,
  replayAutomation,
  saveAutomationRule,
} from "./service";
import { installAutomationLibrary } from "./library";
import { routing, type AppLocale } from "@/i18n/routing";

export type AutomationFormState = {
  status: "idle" | "success" | "error";
  message?:
    | "saved"
    | "updated"
    | "previewed"
    | "replayed"
    | "installed"
    | "invalid"
    | "failed"
    | "stale"
    | "unauthorized";
  preview?: Awaited<ReturnType<typeof previewAutomation>>;
};
export async function automationAction(
  locale: string,
  _state: AutomationFormState,
  data: FormData,
): Promise<AutomationFormState> {
  const appLocale = routing.locales.includes(locale as AppLocale)
    ? locale
    : routing.defaultLocale;
  const actor = await reservationActorContextFromSession(await auth());
  if (!actor) return { status: "error", message: "unauthorized" };
  const kind = z
    .enum(["save", "state", "preview", "replay", "library"])
    .safeParse(data.get("command"));
  if (!kind.success) return { status: "error", message: "invalid" };
  const meta = {
    requestId: (await headers()).get("x-request-id") ?? crypto.randomUUID(),
  };
  try {
    const value = (key: string) => data.get(key) || undefined;
    let message: AutomationFormState["message"],
      preview: AutomationFormState["preview"];
    if (kind.data === "save") {
      const rule = JSON.parse(
        z.string().parse(data.get("ruleJson")),
      ) as unknown;
      const utc = (key: string) => {
        const raw = value(key);
        return typeof raw === "string" && raw ? raw + "Z" : undefined;
      };
      await saveAutomationRule(
        actor,
        {
          key: value("key"),
          propertyId: value("propertyId"),
          lifecycle: value("lifecycle"),
          effectiveFrom: utc("effectiveFrom"),
          effectiveTo: utc("effectiveTo"),
          reason: value("reason"),
          rule,
        },
        meta,
      );
      message = "saved";
    } else if (kind.data === "state") {
      await changeAutomationState(
        actor,
        {
          ruleId: value("ruleId"),
          enabled: data.get("enabled") === "true",
          reason: value("reason"),
        },
        meta,
      );
      message = "updated";
    } else if (kind.data === "preview") {
      preview = await previewAutomation(
        actor,
        { ruleId: value("ruleId"), eventId: value("eventId") },
        meta,
      );
      message = "previewed";
    } else if (kind.data === "replay") {
      await replayAutomation(
        actor,
        { runId: value("runId"), reason: value("reason") },
        meta,
      );
      message = "replayed";
    } else {
      await installAutomationLibrary(
        actor,
        { propertyId: value("propertyId"), reason: value("reason") },
        meta,
      );
      message = "installed";
    }
    revalidatePath(`/${appLocale}/app/automations`);
    return { status: "success", message, ...(preview ? { preview } : {}) };
  } catch (error) {
    return {
      status: "error",
      message:
        error instanceof Error &&
        error.message === "automation_version_conflict"
          ? "stale"
          : error instanceof z.ZodError || error instanceof SyntaxError
            ? "invalid"
            : "failed",
    };
  }
}
