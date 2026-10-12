type ClientSentryDsnParts = {
  dsn: string;
  envelopeUrl: string;
};

function parseClientDsn(dsn: string | undefined): ClientSentryDsnParts | null {
  if (!dsn) {
    return null;
  }

  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const pathParts = url.pathname.split("/").filter(Boolean);
    const projectId = pathParts.at(-1);

    if (!publicKey || !projectId || url.protocol !== "https:") {
      return null;
    }

    const basePath = pathParts.length > 1 ? `/${pathParts.slice(0, -1).join("/")}` : "";
    return {
      dsn,
      envelopeUrl: `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/?sentry_key=${encodeURIComponent(
        publicKey
      )}&sentry_version=7&sentry_client=alvillas-os-client/0.0.0`
    };
  } catch {
    return null;
  }
}

function clientEventId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function reportClientError(error: unknown, source: "window.error" | "unhandledrejection"): void {
  const parsedDsn = parseClientDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);

  if (!parsedDsn) {
    return;
  }

  const eventId = clientEventId();
  const sentAt = new Date().toISOString();
  const errorValue = error instanceof Error ? error.message : String(error);
  const errorType = error instanceof Error ? error.name : typeof error;
  const envelope = [
    JSON.stringify({ event_id: eventId, dsn: parsedDsn.dsn, sent_at: sentAt }),
    JSON.stringify({ type: "event" }),
    JSON.stringify({
      event_id: eventId,
      timestamp: sentAt,
      platform: "javascript",
      logger: "alvillas-os-client",
      level: "error",
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || "browser",
      tags: { source },
      exception: { values: [{ type: errorType, value: errorValue }] },
      request: { url: location.href }
    })
  ].join("\n");

  if (!navigator.sendBeacon(parsedDsn.envelopeUrl, new Blob([envelope], { type: "application/x-sentry-envelope" }))) {
    void fetch(parsedDsn.envelopeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-sentry-envelope" },
      body: envelope,
      keepalive: true
    });
  }
}

try {
  window.addEventListener("error", (event) => {
    reportClientError(event.error ?? event.message, "window.error");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError(event.reason, "unhandledrejection");
  });
} catch {
  // Client instrumentation must never interfere with hydration.
}

export function onRouterTransitionStart(url: string): void {
  try {
    performance.mark(`alvillas-navigation:${url}`);
  } catch {
    // Navigation timing is best-effort only.
  }
}
