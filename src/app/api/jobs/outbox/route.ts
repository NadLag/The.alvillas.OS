import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createInngestOutboxHandlers, InngestConfigurationError } from "@/platform/events/inngest";
import {
  dispatchOutboxBatch,
  dispatchOutboxForAllOrganizations
} from "@/platform/events/outbox-dispatcher";
import { readEnv } from "@/platform/env/env";
import { prisma } from "@/platform/db/client";
import { logger } from "@/platform/observability/logger";

const jobRequestSchema = z
  .object({
    organizationId: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(500).optional()
  })
  .optional();

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

function authorized(request: NextRequest, signingKey: string | undefined): boolean {
  if (!signingKey) {
    return false;
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/iu)?.[1];
  const jobToken = request.headers.get("x-alvillas-job-token");

  return Boolean(
    (bearer && safeEqual(bearer, signingKey)) ||
      (jobToken && safeEqual(jobToken, signingKey))
  );
}

export async function POST(request: NextRequest) {
  const env = readEnv();
  const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();

  if (!authorized(request, env.INNGEST_SIGNING_KEY)) {
    logger.warn("outbox job unauthorized", { requestId });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let input: z.infer<typeof jobRequestSchema>;

  try {
    const text = await request.text();
    input = jobRequestSchema.parse(text ? JSON.parse(text) : undefined);
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  try {
    const handlers = createInngestOutboxHandlers(env);
    const limit = input?.limit ?? 50;
    const result = input?.organizationId
      ? await dispatchOutboxBatch(prisma, input.organizationId, handlers, { limit })
      : await dispatchOutboxForAllOrganizations(prisma, handlers, { limitPerOrganization: limit });

    logger.info("outbox job completed", { requestId }, result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof InngestConfigurationError) {
      logger.error("outbox job missing inngest configuration", { requestId }, { error });
      return NextResponse.json({ error: "inngest_not_configured" }, { status: 503 });
    }

    logger.error("outbox job failed", { requestId }, { error });
    return NextResponse.json({ error: "dispatch_failed" }, { status: 500 });
  }
}
