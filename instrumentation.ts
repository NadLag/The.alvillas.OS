import type { Instrumentation } from "next";
import { logger } from "@/platform/observability/logger";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { isSentryConfigured } = await import("@/platform/observability/sentry");

  logger.info("server instrumentation registered", {
    requestId: process.env.VERCEL_DEPLOYMENT_ID,
    jobId: process.env.VERCEL_GIT_COMMIT_SHA
  }, {
    sentryConfigured: isSentryConfigured({
      SENTRY_DSN: process.env.SENTRY_DSN
    })
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const requestId =
    typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : undefined;

  logger.error(
    "next request error",
    { requestId },
    {
      path: request.path,
      method: request.method,
      routePath: context.routePath,
      routeType: context.routeType,
      routerKind: context.routerKind
    }
  );

  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  const { captureException } = await import("@/platform/observability/sentry");

  await captureException(error, {
    source: "next",
    requestId,
    route: context.routePath,
    method: request.method,
    extra: {
      path: request.path,
      routeType: context.routeType,
      routerKind: context.routerKind,
      renderSource: context.renderSource,
      revalidateReason: context.revalidateReason
    }
  });
};
