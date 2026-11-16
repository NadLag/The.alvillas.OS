import "fake-indexeddb/auto";
import {randomUUID} from "node:crypto";
import {afterEach,describe,expect,it} from "vitest";
import {FieldQueue} from "@/platform/offline/field-queue";
import {refreshFieldCache} from "@/platform/offline/field-pull";
import {fieldWorkSnapshotSchema,type FieldWorkSnapshot} from "@/modules/reservations/domain/field-pull";
import {ownedChefMenu} from "../support/chef-menu-definition";
const stores:FieldQueue[]=[];
afterEach(async()=>{await Promise.all(stores.splice(0).map(store=>store.delete()));});
function task():FieldWorkSnapshot{
 const id=randomUUID(),propertyId=randomUUID(),menu={schemaVersion:ownedChefMenu.schemaVersion,serving_quantity:ownedChefMenu.serving_quantity,serving_basis:ownedChefMenu.serving_basis,ingredients:ownedChefMenu.ingredients,preparation:ownedChefMenu.preparation,allergens:ownedChefMenu.allergens};
 return{id,propertyId,propertyName:"Owned offline chef villa",propertyAddress:"Owned test address",propertyTimezone:"Africa/Casablanca",reservationReference:null,title:{en:"Cook",fr:"Cuisiner",ar:"الطهي"},type:"CHEF",state:"ASSIGNED",priority:"NORMAL",dueDate:"2031-05-01",businessDate:"2026-11-16",serverVersion:new Date().toISOString(),revision:"A".repeat(43),canEdit:true,checklistItems:[],chefRecipe:{taskId:id,orderId:randomUUID(),propertyId,name:{en:"Menu",fr:"Menu",ar:"القائمة"},description:{en:"Owned menu",fr:"Menu contrôlé",ar:"قائمة للاختبار"},quantity:2,guests:1,serviceDate:"2031-05-01",lastServiceDate:"2031-05-01",menu}};
}
describe("owned offline chef recipe cache",()=>{
 it("retains original recipes across a database reopen, isolates actors and wipes them after permission denial",async()=>{
  const queue=new FieldQueue("chef-cache-"+randomUUID());stores.push(queue);const scope={organizationId:randomUUID(),userId:randomUUID()},original=task();await queue.activate(scope);
  const send:typeof fetch=async input=>{expect(new URL(String(input),"http://localhost").searchParams.get("include_chef_menu")).toBe("1");return Response.json({op_schema_version:1,organization_id:scope.organizationId,actor_user_id:scope.userId,snapshot_at:new Date().toISOString(),cursor:"owned-checkpoint",next_cursor:null,tasks:[original],known_changes:[],tombstones:[]});};
  await refreshFieldCache(queue,scope,send);queue.close();await queue.open();expect((await queue.cachedJobs(scope))[0].chefRecipe).toEqual(original.chefRecipe);await expect(queue.cachedJobs({...scope,userId:randomUUID()})).rejects.toThrow("FIELD_SESSION_CHANGED");expect(JSON.stringify((await queue.cachedJobs(scope))[0].chefRecipe)).not.toMatch(/internal_cost|allocation_rule_id|tax_rule_id|chef_component_key|financialPolicy/);
  await expect(refreshFieldCache(queue,scope,async()=>Response.json({error:"forbidden"},{status:403}))).rejects.toThrow("FIELD_SESSION_CHANGED");expect(await queue.jobs.count()).toBe(0);await expect(queue.cachedJobs(scope)).rejects.toThrow("FIELD_SESSION_CHANGED");
 });
 it("refuses recipes from another task or property and financial/private additions to the offline contract",()=>{
  const original=task();expect(fieldWorkSnapshotSchema.safeParse(original).success).toBe(true);expect(fieldWorkSnapshotSchema.safeParse({...original,type:"TRANSFER"}).success).toBe(false);
  for(const changes of[{taskId:randomUUID()},{propertyId:randomUUID()},{internal_cost:{amount:"30.00",currency:"MAD"}}])expect(fieldWorkSnapshotSchema.safeParse({...original,chefRecipe:{...original.chefRecipe,...changes}}).success).toBe(false);
 });
});
