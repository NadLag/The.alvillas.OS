import type {TenantTransaction} from "@/platform/db/tenant";
import {SupplierPriceRepository} from "@/modules/inventory/infrastructure/supplier-price-repository";
import {laundryPricingSupplierId,laundrySupplierPricePolicySchema} from "./laundry-pricing-policy";
/** Native configuration versions own prices, effective windows, lifecycle,
 * ordering and inheritance. This row preserves their original supplier link. */
export async function appendLaundrySupplierPriceReference(tx:TenantTransaction,organizationId:string,rule:{id:string;key:string;value:unknown;createdBy:string|null}){const supplierId=laundryPricingSupplierId(rule.key);if(!supplierId)return;if(!rule.createdBy)throw Error("Original supplier price author required");const policy=laundrySupplierPricePolicySchema.parse(rule.value);await new SupplierPriceRepository(tx,organizationId).insertReference({id:rule.id,supplierId,currency:policy.currency,createdBy:rule.createdBy});}
