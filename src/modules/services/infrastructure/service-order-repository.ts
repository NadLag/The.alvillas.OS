import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {advisoryTransactionLock} from "@/platform/db/advisory-lock-repository";
import type {ServiceOrderState} from "../domain/service-order";

const orderHead={id:true,organizationId:true,propertyId:true,reservationId:true,catalogRuleId:true,catalogRuleVersion:true,serviceKey:true,titleTranslations:true,serviceDate:true,lastServiceDate:true,quantity:true,guestCount:true,state:true,version:true,taskId:true,createdBy:true,createdAt:true,updatedAt:true}as const;
export type ChefRecipeRecord={taskId:string;orderId:string;propertyId:string;name:unknown;description:unknown;menu:unknown;quantity:string;guests:number;pricingModel:unknown;dimensions:unknown;serviceDate:string;lastServiceDate:string;rowVersion:string;tuple:string};
/** Public source identity is selected before any private original or price. */
export class ServiceOrderRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 lockCommand(key:string){return advisoryTransactionLock(this.tx,`service-order-command:${this.organizationId}:${key}`);}
 lockOrder(id:string){return advisoryTransactionLock(this.tx,`service-order:${this.organizationId}:${id}`);}
 async clock(){const rows=await this.tx.$queryRaw<Array<{now:Date}>>(Prisma.sql`SELECT clock_timestamp() AS now`);return rows[0].now;}
 head(id:string){return this.tx.serviceOrder.findFirst({where:{organizationId:this.organizationId,id},select:orderHead});}
 byTaskHead(taskId:string){return this.tx.serviceOrder.findFirst({where:{organizationId:this.organizationId,taskId},select:orderHead});}
 chefRequirementHeads(input:{propertyId:string;from:string;through:string}){
  return this.tx.serviceOrder.findMany({where:{organizationId:this.organizationId,propertyId:input.propertyId,state:{in:["REQUESTED","QUOTED","CONFIRMED"]},serviceDate:{lte:new Date(input.through+"T00:00:00Z")},lastServiceDate:{gte:new Date(input.from+"T00:00:00Z")},catalogSnapshot:{path:["order_terms","chef_menu","schemaVersion"],equals:1}},orderBy:{id:"asc"},take:501,select:orderHead});
 }
 chefRequirementRows(orderIds:readonly string[]){
  if(!orderIds.length)return Promise.resolve([]);
  return this.tx.$queryRaw<Array<{orderId:string;ingredients:unknown;servingQuantity:string;pricingModel:unknown;dimensions:unknown}>>(Prisma.sql`SELECT s.id AS "orderId",s.catalog_snapshot#>'{order_terms,chef_menu,ingredients}' AS ingredients,(s.catalog_snapshot#>>'{order_terms,chef_menu,serving_quantity}')::text AS "servingQuantity",s.catalog_snapshot->>'pricing_model' AS "pricingModel",s.request_snapshot->'dimensions' AS dimensions FROM service_order s WHERE s.organization_id=${this.organizationId}::uuid AND s.id IN (${Prisma.join(orderIds.map(id=>Prisma.sql`${id}::uuid`))}) ORDER BY s.id`);
 }
 async chefTaskRecipe(id:string){
  return(await this.chefRecipeRows(Prisma.sql`s.id=${id}::uuid`))[0]??null;
 }
 chefTaskRecipes(taskIds:readonly string[]){
  return taskIds.length?this.chefRecipeRows(Prisma.sql`s.task_id IN (${Prisma.join([...new Set(taskIds)].map(id=>Prisma.sql`${id}::uuid`))})`):Promise.resolve([]);
 }
 private chefRecipeRows(where:Prisma.Sql){
  return this.tx.$queryRaw<ChefRecipeRecord[]>(Prisma.sql`
   SELECT s.task_id AS "taskId",s.id AS "orderId",s.property_id AS "propertyId",s.quantity::text AS quantity,s.guest_count AS guests,s.catalog_snapshot->>'pricing_model' AS "pricingModel",s.request_snapshot->'dimensions' AS dimensions,
    to_char(s.service_date,'YYYY-MM-DD') AS "serviceDate",to_char(s.last_service_date,'YYYY-MM-DD') AS "lastServiceDate",
    s.catalog_snapshot->'name' AS name,s.catalog_snapshot->'description' AS description,
    (s.catalog_snapshot#>'{order_terms,chef_menu}')-'chef_component_key' AS menu,s.xmin::text AS "rowVersion",s.ctid::text AS tuple
   FROM service_order s WHERE s.organization_id=${this.organizationId}::uuid AND ${where}
    AND jsonb_typeof(s.catalog_snapshot#>'{order_terms,chef_menu}')='object'`);
 }
 async chefFinancialWork(id:string){
  const rows=await this.tx.$queryRaw<Array<{hasChefMenu:boolean;chefComponentKey:string|null;chefPersonId:string|null;taskType:string|null;taskState:string|null;performedPersonId:string|null;taskVersion:number|null}>>(Prisma.sql`
   SELECT s.catalog_snapshot#>'{order_terms,chef_menu}' IS NOT NULL AS "hasChefMenu",
    s.catalog_snapshot#>>'{order_terms,chef_menu,chef_component_key}' AS "chefComponentKey",
    (SELECT provider->>'id' FROM jsonb_array_elements(s.catalog_snapshot#>'{order_terms,providers}') provider
     WHERE provider->>'component_key'=s.catalog_snapshot#>>'{order_terms,chef_menu,chef_component_key}' AND provider->>'kind'='PERSON') AS "chefPersonId",
    t.type AS "taskType",t.state AS "taskState",t.completed_by_person_id AS "performedPersonId",t.version AS "taskVersion"
   FROM service_order s LEFT JOIN operation_task t ON t.organization_id=s.organization_id AND t.id=s.task_id
   WHERE s.organization_id=${this.organizationId}::uuid AND s.id=${id}::uuid`);
  return rows[0]?.hasChefMenu?rows[0]:null;
 }
 financialCurrency(id:string){return this.tx.serviceOrder.findFirst({where:{organizationId:this.organizationId,id},select:{currency:true}});}
 original(id:string){return this.tx.serviceOrder.findFirst({where:{organizationId:this.organizationId,id}});}
 byNonce(key:string){return this.tx.serviceOrderEvent.findFirst({where:{organizationId:this.organizationId,commandKey:key},select:{id:true,orderId:true,version:true,toState:true,commandHash:true,createdBy:true,createdAt:true}});}
 create(input:Omit<Prisma.ServiceOrderUncheckedCreateInput,"organizationId">){return this.tx.serviceOrder.create({data:{...input,organizationId:this.organizationId}});}
 async change(id:string,expectedVersion:number,input:Pick<Prisma.ServiceOrderUncheckedUpdateManyInput,"state"|"version"|"totalAmount"|"quoteReference"|"taskId"|"updatedAt">){
  const result=await this.tx.serviceOrder.updateMany({where:{organizationId:this.organizationId,id,version:expectedVersion},data:input});return result.count===1;
 }
 event(input:Omit<Prisma.ServiceOrderEventUncheckedCreateInput,"organizationId">){return this.tx.serviceOrderEvent.create({data:{...input,organizationId:this.organizationId}});}
 page(input:{propertyId:string;reservationId?:string;state?:ServiceOrderState;after?:string}){
  return this.tx.serviceOrder.findMany({where:{organizationId:this.organizationId,propertyId:input.propertyId,...input.reservationId?{reservationId:input.reservationId}:{},...input.state?{state:input.state}:{},...input.after?{id:{gt:input.after}}:{}},orderBy:{id:"asc"},take:21,select:orderHead});
 }
 historyHeads(orderId:string,beforeVersion?:number){return this.tx.serviceOrderEvent.findMany({where:{organizationId:this.organizationId,orderId,...beforeVersion?{version:{lt:beforeVersion}}:{}},orderBy:{version:"desc"},take:21,select:{id:true,orderId:true,version:true,fromState:true,toState:true,createdBy:true,createdAt:true}});}
 historyOriginal(id:string,orderId:string){return this.tx.serviceOrderEvent.findFirst({where:{organizationId:this.organizationId,id,orderId}});}
 async validateAtomicHistory(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS service_order_history_guard,service_order_event_birth_guard,service_order_confirmation_task_guard IMMEDIATE`);}
}
