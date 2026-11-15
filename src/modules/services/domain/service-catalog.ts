import {z} from "zod";
import {Money} from "@/platform/money/money";
import {servicePricingSchema} from "@/platform/config/rule-registry";
import {serviceCatalogOrderTermsSchema} from "@/platform/config/service-catalog-policy";
import {localizedTextSchema} from "@/i18n/content";

export class ServiceCatalogAccessError extends Error{}
export class ServiceCatalogConfigurationError extends Error{}
export class ServiceCatalogConflictError extends Error{}
export class ServiceCatalogValidationError extends Error{}

const originalEntry=servicePricingSchema.shape.services.element;
/** Registered operational fields remain canonical; publishing order terms is an
 * explicit financial decision. Historic onboarding entries keep their semantics. */
export const serviceCatalogPublishEntrySchema=originalEntry.extend({
 name:localizedTextSchema.strict(),
 description:localizedTextSchema.strict().nullable(),
 available:z.boolean(),
 amount:originalEntry.shape.amount.unwrap().nullable(),
 currency:originalEntry.shape.currency.unwrap().nullable(),
 order_terms:serviceCatalogOrderTermsSchema.nullable()
}).strict().superRefine((value,context)=>{
 if(value.pricing_model!=="CUSTOM"&&(value.amount===null||value.currency===null)||value.amount!==null&&value.currency===null)context.addIssue({code:"custom",message:"service_catalog_explicit_price_required"});
 if(value.order_terms&&(value.currency===null||value.currency!==value.order_terms.internal_cost.currency))context.addIssue({code:"custom",message:"service_catalog_cost_currency_must_match"});
});
export type ServiceCatalogEntry=z.infer<typeof originalEntry>;
export type ServiceCatalogPublishEntry=z.infer<typeof serviceCatalogPublishEntrySchema>;

/** Preserve optional legacy fields and exact unknown canonical extensions when
 * editing one item; only the explicitly reviewed registered fields change. */
export function canonicalServiceCatalogEntry(raw:unknown,previous?:ServiceCatalogEntry):ServiceCatalogEntry{
 const value=serviceCatalogPublishEntrySchema.parse(raw);
 if(previous&&previous.key!==value.key)throw new ServiceCatalogConflictError();
 const result:Record<string,unknown>={...previous,key:value.key,name:value.name,available:value.available,pricing_model:value.pricing_model};
 for(const[key,item]of Object.entries({description:value.description,amount:value.amount,currency:value.currency,order_terms:value.order_terms})){
  if(item===null)delete result[key];else result[key]=item;
 }
 if(value.amount!==null&&value.currency!==null)result.amount=Money.of(value.amount,value.currency).toJSON().amount;
 if(value.order_terms)result.order_terms={...value.order_terms,internal_cost:Money.of(value.order_terms.internal_cost.amount,value.order_terms.internal_cost.currency).toJSON()};
 return originalEntry.parse(result);
}

const units=z.object({quantity:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),guests:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),days:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
export type ServiceCatalogUnits=z.infer<typeof units>;
/** Reservation/date authority supplies the integer dimensions. Monetary
 * multiplication stays inside Money and never passes through a JS float. */
export function serviceCatalogPrice(raw:unknown,dimensions:unknown):{kind:"PRICED";amount:Money;units:ServiceCatalogUnits}|{kind:"QUOTE_REQUIRED";indicative:Money|null;units:ServiceCatalogUnits}{
 const item=originalEntry.parse(raw),count=units.parse(dimensions);
 if(item.pricing_model==="CUSTOM")return{kind:"QUOTE_REQUIRED",indicative:item.amount!==undefined&&item.currency!==undefined?Money.of(item.amount,item.currency):null,units:count};
 if(item.amount===undefined||item.currency===undefined)throw new ServiceCatalogConfigurationError();
 const multiplier=BigInt(count.quantity)*(item.pricing_model==="PER_GUEST"?BigInt(count.guests):item.pricing_model==="PER_DAY"?BigInt(count.days):1n),amount=Money.of(item.amount,item.currency).multiply(multiplier.toString());
 if(!originalEntry.shape.amount.unwrap().safeParse(amount.toJSON().amount).success)throw new ServiceCatalogValidationError();
 return{kind:"PRICED",amount,units:count};
}
