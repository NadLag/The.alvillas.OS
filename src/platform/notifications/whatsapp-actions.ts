"use server";

import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { logger } from "@/platform/observability/logger";
import { notificationActorFromSession, NotificationAccessError } from "./notification-service";
import { prepareWhatsapp, saveWhatsappGuestContact, WhatsappPhoneError } from "./whatsapp-service";

export async function whatsappPrepareAction(input: unknown) {
  const requestId = crypto.randomUUID();
  let organizationId: string | undefined;
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) throw new NotificationAccessError();
    organizationId = actor.organizationId;
    const result = await prepareWhatsapp(actor, input, { requestId });
    const draft = { phone: result.phone, message: result.message, locale: result.locale, fingerprint: result.fingerprint };
    return { ok: true as const, draft };
  } catch (error) {
    if (error instanceof WhatsappPhoneError) return { ok: false as const, error: error.code };
    if (!(error instanceof NotificationAccessError) && !(error instanceof z.ZodError)) logger.error("whatsapp preparation failed", { requestId, organizationId });
    return { ok: false as const, error: "unavailable" as const };
  }
}

export async function whatsappContactAction(input: unknown) {
  const requestId = crypto.randomUUID();
  let organizationId: string | undefined;
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) throw new NotificationAccessError();
    organizationId = actor.organizationId;
    await saveWhatsappGuestContact(actor, input, { requestId });
    return { ok: true as const };
  } catch (error) {
    if (!(error instanceof NotificationAccessError) && !(error instanceof z.ZodError)) logger.error("whatsapp contact update failed", { requestId, organizationId });
    return { ok: false as const };
  }
}
