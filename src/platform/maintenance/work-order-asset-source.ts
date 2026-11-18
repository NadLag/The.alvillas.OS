import { readAssetSource } from "@/modules/assets/application/asset-service";
import { AssetAccessError, AssetConflictError } from "@/modules/assets/domain/asset";
import { WorkOrderAccessError, WorkOrderConflictError } from "@/modules/maintenance/domain/work-order";
import type { AccountActorContext } from "@/platform/authz/session-context";
import type { TenantTransaction } from "@/platform/db/tenant";

function translate(error: unknown): never {
  if (error instanceof AssetAccessError) throw new WorkOrderAccessError();
  if (error instanceof AssetConflictError) throw new WorkOrderConflictError();
  throw error;
}
export async function workOrderAssetSource(actor: AccountActorContext, tx: TenantTransaction, id: string, propertyId: string) {
  try {
    const source = await readAssetSource(actor, tx, id, propertyId);
    return { ...source, recheck: async () => { try { await source.recheck(); } catch (error) { translate(error); } } };
  } catch (error) { return translate(error); }
}
