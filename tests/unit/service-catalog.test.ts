import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {Money} from "@/platform/money/money";
import {servicePricingSchema} from "@/platform/config/rule-registry";
import {serviceCatalogOrderTermsSchema,serviceCatalogAvailabilitySchema,servicePricingSchema as canonicalPricing} from "@/platform/config/service-catalog-policy";
import {canonicalServiceCatalogEntry,serviceCatalogPrice,serviceCatalogSelection,ServiceCatalogValidationError} from "@/modules/services/domain/service-catalog";

describe("canonical service catalog and exact configured pricing",()=>{
 it("pages canonical 120-character and numeric service identities without dropping legacy entries",()=>{
  const key="9"+"x".repeat(119),items=canonicalPricing.parse({services:[{key,pricing_model:"CUSTOM"},...Array.from({length:21},(_,i)=>({key:"service_"+String(i).padStart(2,"0"),pricing_model:"CUSTOM",name:{en:"Retained service",fr:"Service conservé"}}))]}).services,first=serviceCatalogSelection(items,{query:""});
  expect(first.selected).toHaveLength(20);expect(first.selected[0].key).toBe(key);const last=serviceCatalogSelection(items,{query:"",after:first.next!});expect(last.selected).toHaveLength(2);expect(new Set([...first.selected,...last.selected].map(row=>row.key)).size).toBe(22);expect(last.next).toBeNull();expect(serviceCatalogSelection(items,{query:"conservé"}).selected).toHaveLength(20);
 });
 it("keeps private configuration and arbitrary personal fields out of guest availability probes",()=>{
  expect(serviceCatalogAvailabilitySchema.safeParse({all:[{path:"request.guests",op:">=",value:2},{path:"request.date",op:">=",value:{field:"reservation.checkInDate"}}]}).success).toBe(true);
  expect(serviceCatalogAvailabilitySchema.safeParse({path:"request.quantity",op:">",value:{config:"finance.commission",path:"rate_bps"}}).success).toBe(false);
  expect(serviceCatalogAvailabilitySchema.safeParse({not:{path:"reservation.guest.passport",op:"exists"}}).success).toBe(false);
  expect(serviceCatalogAvailabilitySchema.safeParse({path:"request.guests",op:"in",value:[{field:"property.internalCost"}]}).success).toBe(false);
 });
 it("preserves legacy onboarding catalogs and unmodified extension data",()=>{
  expect(servicePricingSchema).toBe(canonicalPricing);
  const previous=servicePricingSchema.parse({services:[{key:"chef",pricing_model:"CUSTOM",currency:"MAD",private_original:{version:1}}]}).services[0],next=canonicalServiceCatalogEntry({key:"chef",name:{en:"Chef",fr:"Chef"},description:null,available:true,pricing_model:"CUSTOM",amount:null,currency:"MAD",order_terms:null},previous);
  expect(next.private_original).toEqual(previous.private_original);expect(next.amount).toBeUndefined();expect(next.currency).toBe("MAD");expect(next).not.toHaveProperty("order_terms");
 });
 it.each([["FIXED","0.30"],["PER_GUEST","0.90"],["PER_DAY","1.50"]]as const)("calculates %s with integer dimensions and Money",(pricing_model,expected)=>{
  const priced=serviceCatalogPrice({key:"owned_service",pricing_model,amount:"0.10",currency:"MAD"},{quantity:3,guests:3,days:5});expect(priced.kind).toBe("PRICED");if(priced.kind!=="PRICED")throw Error("Actual configured price required");expect(priced.amount).toBeInstanceOf(Money);expect(priced.amount.toJSON()).toEqual({amount:expected,currency:"MAD"});
 });
 it("requires a real staff quote for CUSTOM without inventing a zero price",()=>{
  const input={quantity:1,guests:2,days:3};expect(serviceCatalogPrice({key:"experience",pricing_model:"CUSTOM"},input)).toEqual({kind:"QUOTE_REQUIRED",indicative:null,units:input});expect(serviceCatalogPrice({key:"experience",pricing_model:"CUSTOM",amount:"12.34",currency:"MAD"},input).kind).toBe("QUOTE_REQUIRED");
 });
 it("rejects fractional dimensions and an amount beyond the existing ledger precision",()=>{
  const item={key:"chef",pricing_model:"PER_GUEST",amount:"9999999999999999.99",currency:"MAD"};expect(()=>serviceCatalogPrice(item,{quantity:1,guests:2,days:1})).toThrow(ServiceCatalogValidationError);expect(()=>serviceCatalogPrice(item,{quantity:1.5,guests:1,days:1})).toThrow();
 });
 it("requires explicit native financial references, provider identities and a configured availability condition",()=>{
  const terms={schemaVersion:1,approval_reference:"Owned explicit catalog approval",internal_cost:{amount:"10.00",currency:"MAD"},providers:[{component_key:"chef",kind:"PERSON",id:randomUUID()}],allocation_rule_id:randomUUID(),tax_rule_id:randomUUID(),availability:{all:[]}};
  expect(serviceCatalogOrderTermsSchema.parse(terms)).toEqual(terms);expect(serviceCatalogOrderTermsSchema.safeParse({...terms,providers:[terms.providers[0],terms.providers[0]]}).success).toBe(false);expect(serviceCatalogOrderTermsSchema.safeParse({...terms,tax_rule_id:undefined}).success).toBe(false);expect(serviceCatalogOrderTermsSchema.safeParse({...terms,availability:undefined}).success).toBe(false);
  expect(()=>canonicalServiceCatalogEntry({key:"chef",name:{en:"Chef",fr:"Chef"},description:null,available:true,pricing_model:"FIXED",amount:"15.00",currency:"EUR",order_terms:terms})).toThrow();
 });
});
