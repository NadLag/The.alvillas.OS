import {randomUUID} from "node:crypto";
import {describe,it,expect} from "vitest";
import {chefMenuSchema,chefMenuQuantitySchema} from "@/platform/config/chef-menu-policy";
import {servicePricingSchema} from "@/platform/config/service-catalog-policy";
import {canonicalServiceCatalogEntry,serviceCatalogPrice,serviceCatalogSelection} from "@/modules/services/domain/service-catalog";
import {validateChefMenuTask,validateChefMenuPerformer} from "@/modules/services/domain/chef-menu";
import {ServiceOrderValidationError,ServiceOrderSourceUnavailableError} from "@/modules/services/domain/service-order";
const text={en:"Original menu",fr:"Menu original",ar:"القائمة الأصلية"},chefId=randomUUID();
const menu={schemaVersion:1 as const,serving_quantity:4,serving_basis:"PER_PRICED_UNIT" as const,chef_component_key:"chef",ingredients:[{key:"tomato",name:text,quantity:"0.000001",unit:{key:"kilogram",name:text}}],preparation:text,allergens:[{key:"sesame",name:text}]};
const entry={key:"chef_dinner",name:text,description:text,available:true,pricing_model:"PER_GUEST" as const,amount:"0.10",currency:"MAD",order_terms:{schemaVersion:1 as const,approval_reference:"Actual owner approved menu rules",internal_cost:{amount:"0.03",currency:"MAD"},providers:[{component_key:"chef",kind:"PERSON" as const,id:chefId}],allocation_rule_id:randomUUID(),tax_rule_id:randomUUID(),availability:{all:[]},chef_menu:menu}};
describe("canonical chef menu definitions",()=>{
 it("uses the existing service price, cost, actual person provider and immutable terms",()=>{
  const catalog=servicePricingSchema.parse({services:[entry]}),published=canonicalServiceCatalogEntry(entry);expect(published).toEqual(catalog.services[0]);
  const result=serviceCatalogPrice(published,{quantity:3,guests:3,days:2});expect(result.kind).toBe("PRICED");if(result.kind!=="PRICED")throw Error("Configured price required");expect(result.amount.toJSON()).toEqual({amount:"0.90",currency:"MAD"});expect(published.order_terms!.internal_cost.amount).toBe("0.03");
 });
 it.each(["name","description"]as const)("requires all three %s translations through direct configuration and native publishing",field=>{
  const invalid={...entry,[field]:{en:text.en,fr:text.fr}};expect(servicePricingSchema.safeParse({services:[invalid]}).success).toBe(false);expect(()=>canonicalServiceCatalogEntry(invalid)).toThrow();
 });
 it("rejects a supplier as the chef and a nonexistent person component",()=>{
  expect(servicePricingSchema.safeParse({services:[{...entry,order_terms:{...entry.order_terms,providers:[{...entry.order_terms.providers[0],kind:"SUPPLIER"}]}}]}).success).toBe(false);
  expect(chefMenuSchema.parse(menu).ingredients[0].quantity).toBe("0.000001");expect(chefMenuSchema.safeParse({...menu,chef_component_key:""}).success).toBe(false);
 });
 it.each(["0","0.000000","-1","0.0000001","1e3","NaN","Infinity","1000000000000"])("rejects invalid recipe quantity %s",quantity=>{expect(chefMenuQuantitySchema.safeParse(quantity).success).toBe(false);});
 it("requires servings, ingredients, explicit units and translated preparation/allergens without defaulting them",()=>{
  for(const change of [{serving_quantity:0},{serving_quantity:1.5},{ingredients:[]},{ingredients:[menu.ingredients[0],menu.ingredients[0]]},{preparation:{en:"Cook",fr:"Cuire"}},{allergens:[{key:"sesame",name:{en:"Sesame",fr:"Sésame"}}]}])expect(chefMenuSchema.safeParse({...menu,...change}).success).toBe(false);
  expect(chefMenuSchema.safeParse({...menu,allergens:[]}).success).toBe(true);
 });
 it("requires a native cooking task and the actual selected chef at fulfillment",()=>{
  expect(()=>validateChefMenuTask(entry,"CHEF")).not.toThrow();expect(()=>validateChefMenuTask(entry,"TRANSFER")).toThrow(ServiceOrderValidationError);
  expect(()=>validateChefMenuPerformer(entry,chefId)).not.toThrow();expect(()=>validateChefMenuPerformer(entry,randomUUID())).toThrow(ServiceOrderSourceUnavailableError);expect(()=>validateChefMenuPerformer(entry,null)).toThrow(ServiceOrderSourceUnavailableError);
 });
 it("preserves unknown canonical extensions and original recipes across an unrelated edit",()=>{
  const original=canonicalServiceCatalogEntry(entry);const next=canonicalServiceCatalogEntry({...entry,name:{...text,en:"Reviewed new menu title"}},{...original,private_original:{retained:true}});expect(next.order_terms?.chef_menu).toEqual(original.order_terms?.chef_menu);expect(next.private_original).toEqual({retained:true});expect(original.name).toEqual(text);
 });
 it("filters the canonical catalog and pages large multilingual recipes without losing any menu identity",()=>{
  const big={...entry,order_terms:{...entry.order_terms,chef_menu:{...menu,ingredients:Array.from({length:100},(_,i)=>({...menu.ingredients[0],key:"item_"+i,name:{en:"e".repeat(240),fr:"f".repeat(240),ar:"ع".repeat(240)},unit:{key:"unit",name:{en:"u".repeat(240),fr:"v".repeat(240),ar:"و".repeat(240)}}}))}}},items=Array.from({length:8},(_,i)=>({...big,key:"menu_"+i})),keys:string[]=[];let after:string|undefined;
  do{const page=serviceCatalogSelection([...items,{key:"ordinary",pricing_model:"CUSTOM"}],{query:"",kind:"CHEF_MENU",after});expect(page.selected.length).toBeGreaterThan(0);expect(page.selected.length).toBeLessThan(items.length);keys.push(...page.selected.map(item=>item.key));after=page.next??undefined;}while(after);
  expect(keys).toEqual(items.map(item=>item.key));expect(new Set(keys).size).toBe(items.length);
 });
});
