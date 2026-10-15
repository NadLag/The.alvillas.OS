import type { OutboxEvent as PrismaOutboxEvent } from "@prisma/client";
import type { OutboxHandlers } from "@/platform/events/outbox-dispatcher";
import type { EmailProvider } from "@/platform/providers";
import { ResendEmailProvider, EmailNotificationChannel } from "@/platform/providers/real";
import { deliverNotificationChannel, notificationChannelEventType } from "@/platform/notifications/notification-channel-service";
import { renderIdentityEmail } from "@/platform/email/identity-templates";
import { deliverNotificationEvent } from "@/platform/notifications/notification-service";
import { notificationEventType } from "@/platform/notifications/notification";
import { shouldDeliverNotification } from "@/platform/notifications/notification-preferences";
import { deliverPushChannel } from "@/platform/notifications/push-delivery-service";

export type InngestSendResult = {
  ids: string[];
  status: number;
};

export type InngestTransport = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
  }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

type InngestEnv = Record<string, string | undefined>;

export class InngestConfigurationError extends Error {
  constructor(message = "INNGEST_EVENT_KEY is required to dispatch outbox events") {
    super(message);
  }
}

function eventApiUrl(baseUrl: string, eventKey: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;

  return `${normalizedBase}/e/${encodeURIComponent(eventKey)}`;
}

export function createInngestOutboxHandler(
  env: InngestEnv = process.env,
  transport: InngestTransport = fetch
) {
  const eventKey = env.INNGEST_EVENT_KEY;

  if (!eventKey) {
    throw new InngestConfigurationError();
  }

  const url = eventApiUrl(env.INNGEST_EVENT_URL || "https://inn.gs", eventKey);

  return async function sendOutboxEventToInngest(event: PrismaOutboxEvent): Promise<InngestSendResult> {
    const payload = {
      id: `${event.type}:${event.idempotencyKey}`,
      name: event.type,
      data: {
        organizationId: event.organizationId,
        outboxEventId: event.id,
        ...((event.payload ?? {}) as Record<string, unknown>)
      },
      ts: event.occurredAt.getTime()
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (env.INNGEST_ENV) {
      headers["x-inngest-env"] = env.INNGEST_ENV;
    }

    const response = await transport(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Inngest event dispatch failed with status ${response.status}`);
    }

    const body = (await response.json()) as Partial<InngestSendResult>;

    return {
      ids: Array.isArray(body.ids) ? body.ids.map(String) : [],
      status: typeof body.status === "number" ? body.status : response.status
    };
  };
}

export function createInngestOutboxHandlers(
  env: InngestEnv = process.env,
  transport: InngestTransport = fetch,
  emailProvider?: EmailProvider
): OutboxHandlers {
  const handler = (event: PrismaOutboxEvent) => createInngestOutboxHandler(env, transport)(event);
  const identityDelivery = async (event: PrismaOutboxEvent) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.channel !== "email") {
      await handler(event);
      return;
    }
    const email = renderIdentityEmail(event.type, payload, env.APP_URL ?? "http://localhost:3000");
    // Required account-access emails share the notification policy and always
    // survive optional channel/category opt-outs (including before activation).
    if (!shouldDeliverNotification(event.type, "email", null)) return;
    const provider = emailProvider ?? new ResendEmailProvider(env);
    await provider.send({ ...email, idempotencyKey: `identity-email:${event.organizationId}:${event.id}` });
  };

  return {
    [notificationChannelEventType]: async (event) => {
      if ((event.payload as Record<string, unknown>).channel === "push") { await deliverPushChannel(event, { env }); return; }
      await deliverNotificationChannel(event, { appUrl: env.APP_URL ?? "http://localhost:3000", channels: {
        ...(emailProvider || (env.RESEND_API_KEY && env.EMAIL_FROM) ? { email: new EmailNotificationChannel(emailProvider ?? new ResendEmailProvider(env)) } : {})
      } });
    },
    [notificationEventType]: async (event) => { await deliverNotificationEvent(event); },
    "identity.invitation.delivery_requested": identityDelivery,
    "identity.recovery.delivery_requested": identityDelivery,
    "*": async (event) => {
      await handler(event);
    }
  };
}
