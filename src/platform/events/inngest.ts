import type { OutboxEvent as PrismaOutboxEvent } from "@prisma/client";
import type { OutboxHandlers } from "@/platform/events/outbox-dispatcher";
import type { EmailProvider } from "@/platform/providers";
import { deliverEmail } from "@/platform/notifications/email-delivery-service";
import { notificationChannelEventType } from "@/platform/notifications/notification-channel-service";
import { deliverNotificationEvent } from "@/platform/notifications/notification-service";
import { notificationEventType } from "@/platform/notifications/notification";
import { deliverPushChannel } from "@/platform/notifications/push-delivery-service";
import type { TenantTransactionRunner } from "@/platform/db/tenant";
import { z } from "zod";
import { digestEventType } from "@/platform/notifications/digest";
import { deliverDigest } from "@/platform/notifications/digest-service";

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
    signal?: AbortSignal;
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
      id: `${event.organizationId}:${event.id}`,
      name: event.type,
      data: {
        organizationId: event.organizationId,
        outboxEventId: event.id
      },
      ts: event.occurredAt.getTime()
    };
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };

    if (env.INNGEST_ENV) {
      headers["x-inngest-env"] = env.INNGEST_ENV;
    }

    let response;
    try { response = await transport(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10000) }); }
    catch { throw new Error("Inngest event transport did not acknowledge delivery"); }

    if (!response.ok) {
      throw new Error(`Inngest event dispatch failed with status ${response.status}`);
    }

    try { return z.object({ ids: z.array(z.string().min(1)).min(1), status: z.number().int().min(200).max(299) }).parse(await response.json()); }
    catch { throw new Error("Inngest event response did not acknowledge delivery"); }
  };
}

export function createInngestOutboxHandlers(
  env: InngestEnv = process.env,
  transport: InngestTransport = fetch,
  emailProvider?: EmailProvider,
  deps: { db?: TenantTransactionRunner; now?: Date } = {}
): OutboxHandlers {
  const handler = (event: PrismaOutboxEvent) => createInngestOutboxHandler(env, transport)(event);
  const identityDelivery = async (event: PrismaOutboxEvent) => {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (payload.channel !== "email") {
      await handler(event);
      return;
    }
    await deliverEmail(event, { db: deps.db, env, now: deps.now, provider: emailProvider });
  };

  return {
    [digestEventType]: async (event) => { await deliverDigest(event, { env, db: deps.db, now: deps.now, provider: emailProvider }); },
    [notificationChannelEventType]: async (event) => {
      if ((event.payload as Record<string, unknown>).channel === "push") { await deliverPushChannel(event, { env, db: deps.db }); return; }
      await deliverEmail(event, { db: deps.db, env, now: deps.now, provider: emailProvider });
    },
    [notificationEventType]: async (event) => { await deliverNotificationEvent(event, { db: deps.db }); },
    "identity.invitation.delivery_requested": identityDelivery,
    "identity.recovery.delivery_requested": identityDelivery,
    "*": async (event) => {
      await handler(event);
    }
  };
}
