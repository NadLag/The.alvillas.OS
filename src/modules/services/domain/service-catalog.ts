import {z} from "zod";
import {serviceUnitsSchema,servicePricedUnits} from "@/platform/services/priced-units";
import {Money} from "@/platform/money/money";
import {servicePricingSchema,serviceCatalogOrderTermsSchema} from "@/platform/config/service-catalog-policy";
import {localizedTextSchema} from "@/i18n/content";
import {chefMenuTextSchema} from "@/platform/config/chef-menu-policy";

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
 if(value.order_terms?.chef_menu&&(!chefMenuTextSchema.safeParse(value.name).success||!chefMenuTextSchema.safeParse(value.description).success||value.amount===null||value.currency===null))context.addIssue({code:"custom",message:"chef_menu_complete_multilingual_price_required"});
});
export type ServiceCatalogEntry=z.infer<typeof originalEntry>;
export type ServiceCatalogPublishEntry=z.infer<typeof serviceCatalogPublishEntrySchema>;
export function serviceCatalogSelection(items:readonly ServiceCatalogEntry[],input:{after?:string;query:string;kind?:"ALL"|"CHEF_MENU"}){
 const needle=input.query.toLocaleLowerCase(),matching=items.filter(row=>(input.kind!=="CHEF_MENU"||Boolean(row.order_terms?.chef_menu))&&(!input.after||row.key>input.after)&&(!needle||[row.key,...Object.values(row.name??{})].some(text=>text.toLocaleLowerCase().includes(needle)))).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0),selected:ServiceCatalogEntry[]=[];
 // Bound recipe bytes as well as row count so rich multilingual menus fit the
 // existing private response protocol. A cursor never drops an unselected row.
 let bytes=0;const encoder=new TextEncoder();
 for(const entry of matching){const size=encoder.encode(JSON.stringify(entry)).byteLength;if(selected.length===20||selected.length>0&&bytes+size>524288)break;selected.push(entry);bytes+=size;}
 return{selected,next:matching.length>selected.length?selected.at(-1)!.key:null};
}

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

const units=serviceUnitsSchema;
export type ServiceCatalogUnits=z.infer<typeof units>;
/** Reservation/date authority supplies the integer dimensions. Monetary
 * multiplication stays inside Money and never passes through a JS float. */
export function serviceCatalogPrice(raw:unknown,dimensions:unknown):{kind:"PRICED";amount:Money;units:ServiceCatalogUnits}|{kind:"QUOTE_REQUIRED";indicative:Money|null;units:ServiceCatalogUnits}{
 const item=originalEntry.parse(raw),count=units.parse(dimensions);
 if(item.pricing_model==="CUSTOM")return{kind:"QUOTE_REQUIRED",indicative:item.amount!==undefined&&item.currency!==undefined?Money.of(item.amount,item.currency):null,units:count};
 if(item.amount===undefined||item.currency===undefined)throw new ServiceCatalogConfigurationError();
 const multiplier=servicePricedUnits(item.pricing_model,count),amount=Money.of(item.amount,item.currency).multiply(multiplier.toString());
 if(!originalEntry.shape.amount.unwrap().safeParse(amount.toJSON().amount).success)throw new ServiceCatalogValidationError();
 return{kind:"PRICED",amount,units:count};
}
