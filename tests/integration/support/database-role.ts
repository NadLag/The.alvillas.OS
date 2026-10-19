import type { PrismaClient } from "@prisma/client";

// GRANT to different test roles still updates the same pg_class ACL tuple.
// Serialize catalog setup across suites without serializing business tests.
export async function provisionIntegrationRole(admin: PrismaClient, role: "alvillas_app_test" | "alvillas_team_tests" | "alvillas_ops_tests") {
  await admin.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('alvillas-integration-role-provisioning'))`;
    await tx.$executeRawUnsafe(`DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $$`);
    await tx.$executeRawUnsafe(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${role}'`);
    await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await tx.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await tx.$executeRawUnsafe(`REVOKE UPDATE,DELETE ON audit_log, notification_delivery_log, notification_email_suppression FROM ${role}`);
  });
}
