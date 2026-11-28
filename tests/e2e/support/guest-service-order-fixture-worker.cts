import { PrismaClient } from "@prisma/client";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { withTenant } from "@/platform/db/tenant";
import { guestHubVerificationPolicyKey } from "@/modules/guest-hub/domain/guest-hub-policy";
import { nativeGuestCategorizedOrdersFixture, nativeGuestSpecialOrderFixture, nativeGuestServiceOrderFixture,
  prepareGuestServiceOrderCapability } from "../../integration/support/guest-service-order-fixture";
import { nativeChefMenuFixture } from "../../integration/support/chef-menu-fixture";
import { provisionIntegrationRole } from "../../integration/support/database-role";

async function prepare() {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://127.0.0.1/undefined");
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !(url.pathname === "/alvillas_guest_orders_isolated_20261128" || process.env.GITHUB_ACTIONS === "true" && url.pathname === "/alvillas_os")) {
    throw new Error("Use an isolated native guest-order browser database");
  }
  const admin = new PrismaClient({ datasourceUrl: url.toString() });
  let db: PrismaClient | undefined;
  try {
    await provisionIntegrationRole(admin, "alvillas_ops_tests");
    await withTenant(admin, bootstrapOrganizationId, async tx => {
      const repository = new ConfigRuleRepository(tx, bootstrapOrganizationId);
      const scope = { scopeType: "organization", scopeId: null };
      if (await repository.resolveMetadata({ key: guestHubVerificationPolicyKey, scopes: [scope] })) return;
      const actor = await tx.userAccount.findFirstOrThrow({ where: { organizationId: bootstrapOrganizationId }, select: { id: true } });
      await repository.createVersion({ ...scope, key: guestHubVerificationPolicyKey, createdBy: actor.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Owned native browser verification budget",
        value: { source: "NATIVE_GUEST_CAPABILITY_VERIFICATION", enabled: true, checks: { requests: 1000, window_seconds: 3600 },
          clients: { requests: 1000, window_seconds: 3600 } } });
    });
    url.username = url.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: url.toString() });
    const mode = process.argv[2];
    const { capability, fixture, decide } = mode === "chef"
      ? await prepareGuestServiceOrderCapability(await nativeChefMenuFixture(admin, db), db, process.env)
      : mode === "categories" ? await nativeGuestCategorizedOrdersFixture(admin, db, process.env)
      : mode === "grocery" || mode === "transfer" ? await nativeGuestSpecialOrderFixture(admin, db, process.env, mode)
      : await nativeGuestServiceOrderFixture(admin, db, process.env);
    await decide("GRANTED");
    process.stdout.write(JSON.stringify({ token: capability.token, serviceKey: fixture.entry.key }));
  } finally {
    await db?.$disconnect();
    await admin.$disconnect();
  }
}

void prepare().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? error.name : "FixtureError");
  process.exitCode = 1;
});
