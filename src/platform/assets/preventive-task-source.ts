import { readAssetSource } from "@/modules/assets/application/asset-service";
import { AssetAccessError } from "@/modules/assets/domain/asset";
import { AssetLifecycleRepository } from "@/modules/assets/infrastructure/asset-lifecycle-repository";
import type { AccountActorContext } from "@/platform/authz/session-context";
import { recheckAccountAuthorization, type CurrentAuthorityCheck } from "@/platform/authz/current-authority";
import type { TenantTransaction } from "@/platform/db/tenant";

export { assetPreventivePrefix } from "@/modules/assets/domain/preventive-schedule";
export { AssetAccessError } from "@/modules/assets/domain/asset";

export async function authorizeAssetScheduleChange(actor: AccountActorContext, tx: TenantTransaction, propertyId: string,
  assetId: string, enabled: boolean, taskChecks: CurrentAuthorityCheck[]) {
  const lifecycle = new AssetLifecycleRepository(tx, actor.organizationId);
  await lifecycle.lock([assetId]);
  const source = await readAssetSource(actor, tx, assetId, propertyId);
  if (enabled && !await lifecycle.active(assetId, propertyId)) throw new AssetAccessError();
  await recheckAccountAuthorization(actor, tx, new Date(), [
    ...source.checks, { action: "edit", resource: source.checks[1].resource }, ...taskChecks
  ], new AssetAccessError());
}

export async function activeAssetsForScheduling(tx: TenantTransaction, organizationId: string, propertyId: string, ids: string[]) {
  const lifecycle = new AssetLifecycleRepository(tx, organizationId);
  await lifecycle.lock(ids);
  const active = new Set<string>();
  for (const id of ids) if (await lifecycle.active(id, propertyId)) active.add(id);
  return active;
}
