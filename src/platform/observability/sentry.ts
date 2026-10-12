import { randomUUID } from "node:crypto";
import { readEnv, type AppEnv } from "@/platform/env/env";
import { redactSensitiveData } from "@/platform/observability/logger";

export type SentryDsnParts = {
  dsn: string;
  publicKey: string;
  projectId: string;
  envelopeUrl: string;
};

export type SentryCaptureContext = {
  source: "next" | "api" | "job" | "outbox" | "client";
  requestId?: string;
  organizationId?: string;
  userId?: string;
  jobId?: string;
  route?: string;
  method?: string;
  tags?: Record<string, string | undefined>;
  extra?: Record<string, unknown>;
};

export type SentryCaptureResult =
  | { sent: true; eventId: string; status: number }
  | { sent: false; reason: "not_configured" | "invalid_dsn" | "transport_error"; detail?: string };

type EnvLike = Partial<AppEnv> & Record<string, string | undefined>;

export type SentryTransport = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    keepalive?: boolean;
  }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function compactTags(tags: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tags).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function serializeError(error: unknown): {
  type: string;
  value: string;
  stacktrace?: { frames: Array<{ filename?: string; function?: string; lineno?: number; colno?: number }> };
} {
  if (!(error instanceof Error)) {
    return { type: typeof error, value: String(error) };
  }

  const frames =
    error.stack
      ?.split("\n")
      .slice(1)
      .map((line) => line.trim())
      .map((line) => {
        const match = line.match(/^at (?:(?<fn>.+?) \()?((?<file>.+?):(?<line>\d+):(?<col>\d+))\)?$/u);

        return {
          filename: match?.groups?.file ?? line,
          function: match?.groups?.fn,
          lineno: match?.groups?.line ? Number(match.groups.line) : undefined,
          colno: match?.groups?.col ? Number(match.groups.col) : undefined
        };
      }) ?? [];

  return {
    type: error.name || "Error",
    value: error.message,
    ...(frames.length > 0 ? { stacktrace: { frames: frames.reverse() } } : {})
  };
}

export function parseSentryDsn(dsn: string | undefined): SentryDsnParts | null {
  if (!dsn) {
    return null;
  }

  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const pathParts = url.pathname.split("/").filter(Boolean);
    const projectId = pathParts.at(-1);

    if (!publicKey || !projectId || (url.protocol !== "https:" && url.protocol !== "http:")) {
      return null;
    }

    const basePath = pathParts.length > 1 ? `/${pathParts.slice(0, -1).join("/")}` : "";
    const envelopeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(
      publicKey
    )}&sentry_version=7&sentry_client=alvillas-os/0.0.0`;

    return {
      dsn,
      publicKey,
      projectId,
      envelopeUrl
    };
  } catch {
    return null;
  }
}

export function isSentryConfigured(env: Pick<AppEnv, "SENTRY_DSN"> = readEnv()): boolean {
  return parseSentryDsn(env.SENTRY_DSN)?.envelopeUrl !== undefined;
}

export async function captureException(
  error: unknown,
  context: SentryCaptureContext,
  options: {
    env?: EnvLike;
    transport?: SentryTransport;
    now?: Date;
    eventId?: string;
  } = {}
): Promise<SentryCaptureResult> {
  const env: EnvLike = options.env ?? process.env;
  const parsedDsn = parseSentryDsn(env.SENTRY_DSN);

  if (!env.SENTRY_DSN) {
    return { sent: false, reason: "not_configured" };
  }

  if (!parsedDsn) {
    return { sent: false, reason: "invalid_dsn" };
  }

  const eventId = (options.eventId ?? randomUUID()).replaceAll("-", "");
  const sentAt = (options.now ?? new Date()).toISOString();
  const release = env.VERCEL_GIT_COMMIT_SHA || env.npm_package_version;
  const environment = env.SENTRY_ENVIRONMENT || env.VERCEL_ENV || env.NODE_ENV || "development";
  const exception = serializeError(error);
  const event = {
    event_id: eventId,
    timestamp: sentAt,
    platform: "javascript",
    logger: "alvillas-os",
    level: "error",
    environment,
    ...(release ? { release } : {}),
    tags: compactTags({
      source: context.source,
      route: context.route,
      method: context.method,
      requestId: context.requestId,
      organizationId: context.organizationId,
      userId: context.userId,
      jobId: context.jobId,
      ...context.tags
    }),
    exception: { values: [exception] },
    extra: redactSensitiveData(context.extra ?? {})
  };
  const envelope = [
    JSON.stringify({ event_id: eventId, dsn: parsedDsn.dsn, sent_at: sentAt }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event)
  ].join("\n");
  const transport = options.transport ?? fetch;

  try {
    const response = await transport(parsedDsn.envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
      keepalive: true
    });

    if (!response.ok) {
      return {
        sent: false,
        reason: "transport_error",
        detail: `Sentry responded with ${response.status}`
      };
    }

    return { sent: true, eventId, status: response.status };
  } catch (transportError) {
    return {
      sent: false,
      reason: "transport_error",
      detail: transportError instanceof Error ? transportError.message : "Sentry transport failed"
    };
  }
}
