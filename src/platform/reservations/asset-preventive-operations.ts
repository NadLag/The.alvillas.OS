import { OperationRepository } from "@/modules/reservations/infrastructure/operation-repository";
import type { TenantTransaction } from "@/platform/db/tenant";

export { saveOperationSeries } from "@/modules/reservations/application/operation-automation";
export type { OperationDeps } from "@/modules/reservations/application/operation-service";
export { ReservationAuthorizationError, ReservationConflictError } from "@/modules/reservations/application/reservation-service";

export async function assetPreventiveOptions(tx: TenantTransaction, organizationId: string, propertyId: string, now: Date, includeChecklists: boolean) {
  const operations = new OperationRepository(tx, organizationId);
  const [rule, checklists] = await Promise.all([
    operations.recurring(propertyId, now),
    includeChecklists ? operations.checklists(propertyId) : null
  ]);
  return { rule, checklists: checklists?.catalog.checklists.map(({ key, name }) => ({ key, name })) ?? [] };
}
