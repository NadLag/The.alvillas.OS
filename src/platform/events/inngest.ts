import type { OutboxEvent as PrismaOutboxEvent } from "@prisma/client";
import type { OutboxHandlers } from "@/platform/events/outbox-dispatcher";

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
      const detail = await response.text();
      throw new Error(`Inngest event dispatch failed with ${response.status}: ${detail}`);
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
  transport: InngestTransport = fetch
): OutboxHandlers {
  const handler = createInngestOutboxHandler(env, transport);

  return {
    "*": async (event) => {
      await handler(event);
    }
  };
}
