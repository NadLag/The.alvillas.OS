import {expect,it} from "vitest";
import {inventoryLocationDefinition,assertInventoryLocationCanRetire} from "@/modules/inventory/domain/location-catalog";
import {inventoryPropertyScopes} from "@/modules/inventory/application/property-scopes";
import type {AuthContext} from "@/platform/authz/authorize";
const id="018f0a0b-0000-7000-9000-000000000001",at=new Date("2026-11-17");
it("authors each canonical location kind and binds only property locations to their original property",()=>{
 for(const kind of["PROPERTY","STORE","LAUNDRY","IN_TRANSIT"]as const)expect(inventoryLocationDefinition({kind,label:"Actual original physical location",propertyId:kind==="PROPERTY"?id:null}).kind).toBe(kind);
 for(const value of[{kind:"PROPERTY",propertyId:null},{kind:"STORE",propertyId:id}])expect(()=>inventoryLocationDefinition({...value,label:"Invalid physical binding"})).toThrow();
 const original={kind:"PROPERTY",propertyId:id};expect(inventoryLocationDefinition({...original,label:"Renamed original property location"},original)).toMatchObject(original);expect(()=>inventoryLocationDefinition({kind:"STORE",propertyId:null,label:"Cannot move original movements"},original)).toThrow();
});
it("blocks location retirement for each original item stream, including opposite and very large quantities",()=>{
 for(const quantities of[["1","-1"],["9007199254740993"],["-1"]])expect(()=>assertInventoryLocationCanRetire(quantities.map(quantity=>({quantity})))).toThrow();expect(()=>assertInventoryLocationCanRetire([{quantity:"0"}])).not.toThrow();
});
it("derives original property query scopes through native authorization, preserving validity and restrictions",()=>{
 const auth:AuthContext={organizationId:id,userAccountId:id,permissions:new Set(["property:view","inventory_location:view"]),scopes:[],assignments:[{permissions:new Set(["property:view"]),scope:{organizationId:id,scopeType:"property",scopeId:id}},{permissions:new Set(["property:view"]),scope:{organizationId:id,scopeType:"city",scopeId:id},conditions:{statuses:["ACTIVE"]}},{permissions:new Set(["property:view"]),scope:{organizationId:id,scopeType:"organization"},validTo:new Date("2020-01-01")},{permissions:new Set(["inventory_location:view"]),scope:{organizationId:id,scopeType:"organization"}}]};
 expect(inventoryPropertyScopes(auth,at)).toEqual([{organizationId:id,scopeType:"property",scopeId:id}]);expect(inventoryPropertyScopes({...auth,assignments:[]},at)).toEqual([]);expect(inventoryPropertyScopes({...auth,assignments:undefined,permissions:new Set(["property:view"]),scopes:[{organizationId:id,scopeType:"organization"}]},at)).toHaveLength(1);
 expect(inventoryPropertyScopes({...auth,permissions:new Set()},at)).toEqual([]);
});
