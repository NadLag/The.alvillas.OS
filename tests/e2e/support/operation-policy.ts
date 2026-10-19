import { PrismaClient } from "@prisma/client";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { ReservationConfigScopeRepository } from "@/platform/config/reservation-scope-repository";
import { operationPolicySchema } from "@/platform/config/operation-policy";
import defaultPolicy from "@/platform/config/defaults/operations.json" with { type: "json" };

// These journeys exercise the signed-in operator's notifications and field jobs.
// Express that assignment through the production configuration resolver rather
// than relying on the creator receiving every generated task.
export async function preferOperationPerformer(email: string, propertyName: string) {
  const db = new PrismaClient();
  try {
    await withTenant(db, bootstrapOrganizationId, async tx => {
      const account = await tx.userAccount.findFirstOrThrow({ where: { organizationId: bootstrapOrganizationId, email } });
      const property = await tx.property.findFirstOrThrow({ where: { organizationId: bootstrapOrganizationId, name: propertyName } });
      const rules = new ConfigRuleRepository(tx, bootstrapOrganizationId);
      const scopes = await new ReservationConfigScopeRepository(tx, bootstrapOrganizationId).scopes({ propertyId: property.id, asOf: new Date() });
      const resolved = await rules.resolve({ key: 'ops.task_policy', scopes });
      const policy = operationPolicySchema.parse(structuredClone(resolved?.parsedValue ?? defaultPolicy));
      for (const settings of Object.values(policy.types)) { settings.preferred_people = [account.personId]; settings.fallback_people = []; }
      await rules.createVersion({ key: 'ops.task_policy', scopeType: 'property', scopeId: property.id, value: policy, effectiveFrom: new Date('2020-01-01'), createdBy: account.id, reason: 'Browser journey explicitly prefers its signed-in field performer' });
    });
  } finally { await db.$disconnect(); }
}
