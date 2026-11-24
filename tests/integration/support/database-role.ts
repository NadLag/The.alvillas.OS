import { PrismaClient } from "@prisma/client";

const provisioningLock = `
  PERFORM set_config('lock_timeout', '30s', true);
  PERFORM pg_advisory_xact_lock(hashtext('alvillas-integration-role-provisioning'));
`;

// GRANT to different test roles still updates the same pg_class ACL tuple.
// Serialize catalog setup across suites without serializing business tests.
export async function provisionIntegrationRole(admin: Pick<PrismaClient, "$executeRawUnsafe">, role: "alvillas_app_test" | "alvillas_team_tests" | "alvillas_ops_tests") {
  const url = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : null;
  if (!url || !["127.0.0.1", "localhost"].includes(url.hostname) || !["alvillas_app_test", "alvillas_team_tests", "alvillas_ops_tests"].includes(role)) throw Error("Dedicated local role-provisioning cluster required");
  // Roles belong to the cluster, but PostgreSQL advisory locks belong to a database.
  // Every isolated acceptance database must initialize them through the same control database.
  url.pathname = "/postgres";
  const cluster = new PrismaClient({ datasourceUrl: url.toString() });
  try {
    // Keep the lock and catalog changes in one server-side transaction per database.
    await cluster.$executeRawUnsafe(`
      DO $$ BEGIN
        ${provisioningLock}
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} LOGIN;
        END IF;
        ALTER ROLE ${role} WITH LOGIN PASSWORD '${role}';
      END $$;
    `);
  } finally {
    await cluster.$disconnect();
  }
  await admin.$executeRawUnsafe(`
    DO $$ BEGIN
      ${provisioningLock}
      GRANT USAGE ON SCHEMA public TO ${role};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};
      REVOKE UPDATE, DELETE ON audit_log, notification_delivery_log, notification_email_suppression FROM ${role};
    END $$;
  `);
}
