import { createConfigRuleVersion } from "@/modules/config/application/config-service";
import type { AuthContext } from "@/platform/authz/authorize";
import type { TenantTransaction, TenantTransactionRunner } from "@/platform/db/tenant";

// Cross-module orchestration keeps configuration authorization, validation and audit in its existing service.
export async function writePropertyConfiguration(
  ctx: { organizationId: string; actorId: string; personId: string; authContext: AuthContext },
  input: { propertyId: string; key: string; value: unknown; reason: string },
  deps: { tx: TenantTransaction; requestId: string; ipAddress: string | null }
) {
  const db: TenantTransactionRunner = { $transaction: (work) => work(deps.tx) };
  return createConfigRuleVersion(
    ctx,
    {
      key: input.key,
      scopeType: "property",
      scopeId: input.propertyId,
      lifecycle: "ACTIVE",
      valueJson: JSON.stringify(input.value),
      effectiveFrom: new Date(),
      reason: input.reason
    },
    { db, requestId: deps.requestId, ipAddress: deps.ipAddress }
  );
}
