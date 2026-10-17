"use server";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { logger } from "@/platform/observability/logger";
import { captureException } from "@/platform/observability/sentry";
import {
  templateActorFromSession,
  savePropertyTemplate,
  changePropertyTemplate,
  TemplateAccessError,
  TemplateConflictError,
  TemplateNotFoundError
} from "./property-template-service";

export type TemplateActionState = {
  status: "idle" | "success" | "error";
  message: "saved" | "validation" | "forbidden" | "conflict" | "notFound" | "generic";
  id?: string;
};
export async function templateAction(
  locale: string,
  mode: "save" | "change",
  _state: TemplateActionState,
  data: FormData
): Promise<TemplateActionState> {
  const ctx = await templateActorFromSession(await auth());
  if (!ctx) return { status: "error", message: "forbidden" };
  try {
    const payload = data.get("payload");
    if (typeof payload !== "string" || payload.length > 200000)
      return { status: "error", message: "validation" };
    const raw = JSON.parse(payload) as unknown;
    const row =
      mode === "save" ? await savePropertyTemplate(ctx, raw) : await changePropertyTemplate(ctx, raw);
    const appLocale = safeLocale(locale);
    revalidatePath(`/${appLocale}/app/templates`);
    revalidatePath(`/${appLocale}/app/properties`, "layout");
    revalidatePath(`/${appLocale}/app/configuration`);
    return { status: "success", message: "saved", id: row.id };
  } catch (error) {
    const message =
      error instanceof ZodError || error instanceof SyntaxError
        ? "validation"
        : error instanceof TemplateAccessError
          ? "forbidden"
          : error instanceof TemplateConflictError
            ? "conflict"
            : error instanceof TemplateNotFoundError
              ? "notFound"
              : "generic";
    if (message === "generic") {
      const requestId = crypto.randomUUID();
      logger.error("property_template.action_failed", { organizationId: ctx.organizationId, requestId });
      await captureException(new Error("Property template action failed"), {
        source: "next",
        organizationId: ctx.organizationId,
        requestId,
        route: "/app/templates"
      });
    }
    return { status: "error", message };
  }
}
