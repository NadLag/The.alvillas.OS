import {z} from "zod";
import {laundrySupplierPricePolicySchema,type LaundrySupplierPricePolicy} from "@/platform/config/laundry-pricing-policy";
import {Money} from "@/platform/money/money";
import {InventoryCatalogDefinitionError} from "./catalog-errors";
export const laundryPriceChangeEvidenceSchema=z.object({associationId:z.uuid(),basisVersionId:z.uuid(),sourceFingerprint:z.string().regex(/^[a-f0-9]{64}$/u),confirmedUnitPrices:z.literal(true)}).strict();
export type LaundryPriceChangeEvidence=z.infer<typeof laundryPriceChangeEvidenceSchema>;

/** The person reads the supplier-stated unit rates on the original evidence.
 * A total invoice difference never silently becomes a tax or unit-price rule. */
export function validateLaundryPriceChange(basis: LaundrySupplierPricePolicy,raw:unknown,affected:readonly string[]){
 const policy=laundrySupplierPricePolicySchema.parse(raw),allowed=new Set(affected);
 if(policy.currency!==basis.currency||JSON.stringify(policy.billing)!==JSON.stringify(basis.billing)||policy.prices.length!==basis.prices.length)throw new InventoryCatalogDefinitionError();
 const previous=new Map(basis.prices.map(row=>[row.item,row]));let changes=0;
 for(const price of policy.prices){const original=previous.get(price.item);if(!original||original.unit!==price.unit)throw new InventoryCatalogDefinitionError();if(Money.of(original.amount,policy.currency).toJSON().amount!==price.amount){if(!allowed.has(price.item))throw new InventoryCatalogDefinitionError();changes++;}}
 if(!changes)throw new InventoryCatalogDefinitionError();
 return policy;
}
