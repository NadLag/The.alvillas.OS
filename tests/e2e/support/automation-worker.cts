// Run the real server services outside Playwright's browser-module loader.
// The worker reloads the durable source and execution principal; no grants are
// supplied by the browser test or stored in the event envelope.
const { enqueueAutomationEvent, executeAutomationRun } =
  require("../../../src/platform/automation/service.ts") as typeof import("../../../src/platform/automation/service");
const { PrismaClient } =
  require("@prisma/client") as typeof import("@prisma/client");
async function main() {
  const [organizationId, eventId, eventType] = process.argv.slice(2),
    db = new PrismaClient();
  try {
    if (eventType === "source") {
      const { withTenant } =
        require("../../../src/platform/db/tenant.ts") as typeof import("../../../src/platform/db/tenant");
      const { ReservationRepository } =
        require("../../../src/modules/reservations/infrastructure/reservation-repository.ts") as typeof import("../../../src/modules/reservations/infrastructure/reservation-repository");
      const event = await withTenant(db, organizationId, (tx) =>
        new ReservationRepository(tx, organizationId).queueChange(
          eventId,
          1,
          "CONFIRMED",
        ),
      );
      process.stdout.write(JSON.stringify({ id: event.id, type: event.type }));
      return;
    }
    const ids = await enqueueAutomationEvent(organizationId, eventId, { db });
    const statuses = [];
    for (const id of ids)
      statuses.push(
        await executeAutomationRun(organizationId, id, {
          db,
          requestId: crypto.randomUUID(),
        }),
      );
    process.stdout.write(JSON.stringify({ ids, statuses }));
  } finally {
    await db.$disconnect();
  }
}
main().catch(() => {
  process.stderr.write("automation browser worker failed");
  process.exitCode = 1;
});
