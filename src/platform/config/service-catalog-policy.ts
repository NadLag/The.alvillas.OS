import {z} from "zod";
import {ruleConditionSchema,type Condition,type Operand} from "@/platform/automation/rule";
import {configSlugSchema} from "./identifiers";
import {localizedTextSchema} from "@/i18n/content";
import {groceryOrderTermsSchema} from "./grocery-order-policy";
import {transferOrderTermsSchema} from "./transfer-order-policy";
import {chefMenuSchema,chefMenuTextSchema} from "./chef-menu-policy";

export const serviceCatalogRuleKey="services.pricing";
// The existing canonical catalog protocol bounds one property catalog, independently of its configured business minimum.
export const serviceCatalogMaximumItems=200;
export const servicePricingModelSchema=z.enum(["FIXED","PER_GUEST","PER_DAY","CUSTOM"]);
export const serviceCatalogAmountSchema=z.string().trim().regex(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/u,"Use a money amount with up to 2 decimals");
const currency=z.string().trim().regex(/^[A-Z]{3}$/u);

export const serviceCatalogCostSchema=z.object({
 amount:serviceCatalogAmountSchema,
 currency
}).strict();

export const serviceCatalogProviderSchema=z.object({
 component_key:configSlugSchema,
 kind:z.enum(["SUPPLIER","PERSON"]),
 id:z.uuid()
}).strict();
// Availability sees this explicit request/reservation/property projection only.
// Private configuration and arbitrary record paths cannot become guest probes.
export const serviceCatalogAvailabilityFields=new Set([
 "request.quantity","request.guests","request.days","request.date",
 "reservation.status","reservation.source","reservation.checkInDate","reservation.checkOutDate",
 "property.id","property.cityId","property.regionId"
]);
function availabilityOperand(value:Operand|undefined):boolean{
 if(Array.isArray(value))return value.every(availabilityOperand);
 return value===null||typeof value!=="object"||"field"in value&&serviceCatalogAvailabilityFields.has(value.field);
}
function availabilityCondition(value:Condition):boolean{
 if("all"in value)return value.all.every(availabilityCondition);
 if("any"in value)return value.any.every(availabilityCondition);
 if("not"in value)return availabilityCondition(value.not);
 return serviceCatalogAvailabilityFields.has(value.path)&&availabilityOperand(value.value);
}
export const serviceCatalogAvailabilitySchema=ruleConditionSchema.refine(availabilityCondition,"Service availability may use only its public request, reservation and property fields");
/** The canonical catalog references actual immutable financial policy versions.
 * It owns neither another allocation recipe nor a legal tax treatment. */
export const serviceCatalogOrderTermsSchema=z.object({
 schemaVersion:z.literal(1),
 approval_reference:z.string().trim().min(1).max(240),
 internal_cost:serviceCatalogCostSchema,
 providers:z.array(serviceCatalogProviderSchema).max(100).refine(rows=>new Set(rows.map(row=>row.component_key)).size===rows.length,"Provider component identities must be unique"),
 allocation_rule_id:z.uuid(),
 tax_rule_id:z.uuid(),
 availability:serviceCatalogAvailabilitySchema,
 chef_menu:chefMenuSchema.optional(),grocery_order:groceryOrderTermsSchema.optional(),transfer_order:transferOrderTermsSchema.optional()
}).strict().superRefine((value,context)=>{
 if([value.chef_menu,value.grocery_order,value.transfer_order].filter(Boolean).length>1)context.addIssue({code:"custom",message:"one_service_fulfillment_kind_required"});
 if(value.chef_menu&&!value.providers.some(provider=>provider.component_key===value.chef_menu!.chef_component_key&&provider.kind==="PERSON"))context.addIssue({code:"custom",path:["chef_menu","chef_component_key"],message:"chef_menu_actual_person_provider_required"});
});

/** One canonical, browser-safe catalog protocol for configuration, onboarding,
 * staff authoring and reservation-bound service ordering. */
export const servicePricingSchema=z.object({services:z.array(z.object({
 key:configSlugSchema,
 name:localizedTextSchema.optional(),
 description:localizedTextSchema.optional(),
 available:z.boolean().optional(),
 pricing_model:servicePricingModelSchema,
 amount:serviceCatalogAmountSchema.optional(),
 currency:currency.optional(),
 order_terms:serviceCatalogOrderTermsSchema.optional()
}).passthrough()).max(serviceCatalogMaximumItems).refine(rows=>new Set(rows.map(row=>row.key)).size===rows.length,"Service keys must be unique").superRefine((rows,context)=>{
 rows.forEach((value,index)=>{
  if(!value.order_terms?.chef_menu)return;
  if(!chefMenuTextSchema.safeParse(value.name).success)context.addIssue({code:"custom",path:[index,"name"],message:"chef_menu_all_three_names_required"});
  if(!chefMenuTextSchema.safeParse(value.description).success)context.addIssue({code:"custom",path:[index,"description"],message:"chef_menu_all_three_descriptions_required"});
  if(value.amount===undefined||value.currency===undefined)context.addIssue({code:"custom",path:[index,"amount"],message:"chef_menu_explicit_selling_price_required"});
 });
})}).passthrough();
