"use server";

import { z } from "zod";
import { auth } from "@/platform/auth/session";
import { captureException } from "@/platform/observability/sentry";
import { logger } from "@/platform/observability/logger";
import { getNotificationPage, notificationActorFromSession, NotificationAccessError, openNotification, readNotification, type NotificationActor } from "./notification-service";
import { getNotificationPreferences, saveNotificationPreferences } from "./notification-service";
import { getNotificationRouting, saveNotificationRouting } from "./notification-service";
import { pushSettings, savePushSubscription, revokePushSubscription } from "./push-service";

import { saveDigestPreferences } from "./notification-service";
import { digestSettings } from "./digest-service";
import { digestSettingsSchema } from "./digest";
import { deliveryPage, deliveryLogs, retryDelivery } from "./delivery-service";

async function actor() {
  const context = await notificationActorFromSession(await auth());
  if (!context) throw new NotificationAccessError();
  return context;
}
async function safely<T>(work: (context: NotificationActor, requestId: string) => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  const requestId = crypto.randomUUID();
  let context: NotificationActor | undefined;
  try { context = await actor(); return { ok: true, data: await work(context, requestId) }; }
  catch (error) {
    if (!(error instanceof NotificationAccessError) && !(error instanceof z.ZodError)) {
      logger.error("notification action failed", { requestId, organizationId: context?.organizationId });
      await captureException(error, { source: "api", requestId, organizationId: context?.organizationId, tags: { feature: "notification-center" } });
    }
    return { ok: false };
  }
}
export async function notificationPageAction(input: unknown) {
  return safely(async (context) => getNotificationPage(context, input));
}
export async function notificationPreferencesAction() {
  return safely(async (context) => getNotificationPreferences(context));
}
export async function notificationPreferencesSaveAction(input: unknown) {
  return safely(async (context, requestId) => saveNotificationPreferences(context, input, { requestId }));
}
export async function notificationRoutingAction(input: unknown) {
  return safely(async (context) => getNotificationRouting(context, input));
}
export async function notificationRoutingSaveAction(input: unknown) {
  return safely(async (context, requestId) => saveNotificationRouting(context, input, { requestId }));
}
export async function notificationReadAction(id: string) {
  return safely(async (context, requestId) => { await readNotification(context, id, { requestId }); return null; });
}
export async function notificationOpenAction(id: string, locale: string) {
  return safely(async (context) => openNotification(context, id, z.enum(["en", "fr", "ar"]).parse(locale)));
}
export async function pushSettingsAction(input: unknown = {}) { return safely((context) => pushSettings(context, input)); }
export async function pushSubscribeAction(input: unknown) { return safely((context, requestId) => savePushSubscription(context, input, { requestId })); }
export async function pushRevokeAction(input: unknown) { return safely((context, requestId) => revokePushSubscription(context, input, { requestId })); }

export async function digestSettingsAction(input: unknown = {}) { return safely((context) => digestSettings(context, input)); }
export async function deliveryPageAction(input: unknown = {}) { return safely((context) => deliveryPage(context, input)); }
export async function deliveryLogsAction(input: unknown) { return safely((context) => deliveryLogs(context, input)); }
export async function deliveryRetryAction(input: unknown) { return safely((context, requestId) => retryDelivery(context, input, { requestId })); }
export async function digestSaveAction(input: unknown) {
  return safely(async (context, requestId) => {
    const settings = digestSettingsSchema.parse(input);
    // Use the same account lock and preference writer as all channel settings.
    return saveDigestPreferences(context, settings, requestId);
  });
}
