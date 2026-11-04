import { authorizeOtaVarianceSource } from "@/modules/finance/application/variance-source-ota";
import { authorizeBankVarianceSource } from "@/modules/finance/application/variance-source-bank";
import { authorizeStaffVarianceSource } from "@/modules/finance/application/variance-source-staff";
import type { VarianceSourceAuthority } from "@/modules/finance/application/variance-workflow-service";
import { VarianceWorkflowSourceError } from "@/modules/finance/domain/variance-workflow";
import { authorizeInventoryVarianceSource } from "../inventory/variance-workflow-source";

/** Register only adapters backed by real native records; missing host modules fail closed. */
export const authorizeVarianceSource: VarianceSourceAuthority = (ctx, source, tx, access) => {
  const adapter = source.provider === "OTA" ? authorizeOtaVarianceSource : source.provider === "BANK" ? authorizeBankVarianceSource :
    source.provider === "STAFF" ? authorizeStaffVarianceSource : source.provider === "INVENTORY" ? authorizeInventoryVarianceSource : null;
  if (!adapter) throw new VarianceWorkflowSourceError();
  return adapter(ctx, source, tx, access);
};
