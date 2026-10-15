import { Inngest, NonRetriableError } from "inngest";
import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant } from "@/platform/db/tenant";
import { readEnv } from "@/platform/env/env";
import { createInngestOutboxHandlers } from "./inngest";
import { dispatchOutboxBatch, type DispatchOutboxResult } from "./outbox-dispatcher";
import { OutboxRepository, type OutboxDatabase } from "./outbox-repository";
import { outboxDispatchEvent } from "./outbox";

export { outboxDispatchEvent };
export const outboxDispatchInput = z.object({ organizationId: z.string().uuid(), outboxEventId: z.string().uuid() }).strict();

// Cloud mode is explicit: a deployed endpoint never silently disables signatures.
export const inngest = new Inngest({ id: "alvillas-os", env: process.env.INNGEST_ENV,
  isDev: process.env.INNGEST_DEV === "1" && !["preview", "production"].includes(process.env.VERCEL_ENV ?? "") });

export async function dispatchRequestOrganization(input: unknown, db: OutboxDatabase = prisma) {
  const parsed = outboxDispatchInput.safeParse(input);
  if (!parsed.success) throw new NonRetriableError("invalid_outbox_dispatch_reference");
  const { organizationId, outboxEventId } = parsed.data;
  const event = await withTenant(db, organizationId, tx => new OutboxRepository(tx, organizationId).event(outboxEventId));
  if (!event || event.type !== outboxDispatchEvent || event.status === "FAILED") throw new NonRetriableError("outbox_dispatch_reference_denied");
  return organizationId;
}

export async function dispatchOrganization(organizationId: string, db: OutboxDatabase = prisma) {
  return dispatchOutboxBatch(db, organizationId, createInngestOutboxHandlers(readEnv(), undefined, undefined, { db }), { limit: 25 });
}

// This is infrastructure polling cadence; business schedules and push retry policy
// continue to resolve through their existing configuration/consumer paths.
export const dispatchOutbox = inngest.createFunction({ id: "dispatch-outbox", name: "ALVILLAS OS outbox dispatcher",
  // Timer events have no event.id: function-level admission deduplication would
  // suppress subsequent cron ticks. Stable Event API IDs and the database guard
  // duplicate forwarding and delivery without blocking recurring recovery.
  triggers: [{ cron: "* * * * *" }, { event: outboxDispatchEvent }], concurrency: { limit: 1 }, retries: 3
}, async ({ event, step }) => {
  const organizations = event.name === "inngest/scheduled.timer"
    ? await step.run("list-organizations", () => OutboxRepository.organizations(prisma))
    : [{ id: await step.run("validate-dispatch-reference", () => dispatchRequestOrganization(event.data)) }];
  const total: DispatchOutboxResult & { organizations: number } = { organizations: organizations.length, dispatched: 0, failed: 0, skipped: 0 };
  for (const { id } of organizations) {
    const result = await step.run(`dispatch-${id}`, () => dispatchOrganization(id));
    total.dispatched += result.dispatched; total.failed += result.failed; total.skipped += result.skipped;
  }
  return total;
});

export const inngestFunctions = [dispatchOutbox];
