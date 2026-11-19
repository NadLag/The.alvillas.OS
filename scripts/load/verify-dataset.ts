import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";

const input = z.object({
  organizationId: z.uuid(), profile: z.enum(["10", "100", "500"]),
  throughOn: z.iso.date(), revision: z.string().regex(/^[0-9a-f]{40}$/u), databaseUrl: z.url()
}).parse({
  organizationId: process.env.ALVILLAS_LOAD_ORGANIZATION_ID, profile: process.env.ALVILLAS_LOAD_PROFILE,
  throughOn: process.env.ALVILLAS_LOAD_THROUGH_ON, revision: process.env.ALVILLAS_LOAD_EXPECTED_SHA,
  databaseUrl: process.env.ALVILLAS_LOAD_DB_URL
});
const database = new URL(input.databaseUrl);
if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || !database.port
  || !database.pathname.startsWith("/alvillas_load_")) {
  throw new Error("Load verification requires a dedicated loopback fixture database named alvillas_load_*");
}

const through = new Date(input.throughOn + "T00:00:00Z");
const end = new Date(through);
end.setUTCDate(end.getUTCDate() + 1);
const start = new Date(end);
start.setUTCFullYear(start.getUTCFullYear() - 5);
const reportFrom = input.throughOn.slice(0, 7) + "-01";
const expectedProperties = Number(input.profile);
const expectedReservations = expectedProperties * 30 * 60;
const db = new PrismaClient({ datasourceUrl: database.toString() });
try {
  const actual = await withTenant(db, input.organizationId, async (tx) => {
    const [properties, reservations, postings] = await Promise.all([
      tx.property.count({ where: { organizationId: input.organizationId, archivedAt: null } }),
      tx.reservation.count({ where: {
        organizationId: input.organizationId, archivedAt: null, checkIn: { gte: start, lt: end }
      } }),
      tx.posting.count({ where: { organizationId: input.organizationId, transaction: {
        organizationId: input.organizationId, sealed: true, occurredAt: { gte: start, lt: end }
      } } })
    ]);
    return { properties, reservations, postings };
  }, { timeout: 300_000 });
  if (actual.properties !== expectedProperties || actual.reservations < expectedReservations
    || actual.postings < expectedReservations * 50) {
    throw new Error(`Load fixture volume is below the approved profile: ${JSON.stringify(actual)}`);
  }
  console.log(JSON.stringify({
    ...actual, profile: input.profile, revision: input.revision, organizationId: input.organizationId,
    fromOn: start.toISOString().slice(0, 10), throughOn: input.throughOn, reportFrom
  }));
} finally {
  await db.$disconnect();
}
