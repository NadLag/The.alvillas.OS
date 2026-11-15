import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {advisoryTransactionLock} from "@/platform/db/advisory-lock-repository";
import type {ServiceOrderState} from "../domain/service-order";

const orderHead={id:true,organizationId:true,propertyId:true,reservationId:true,catalogRuleId:true,catalogRuleVersion:true,serviceKey:true,titleTranslations:true,serviceDate:true,lastServiceDate:true,quantity:true,guestCount:true,state:true,version:true,taskId:true,createdBy:true,createdAt:true,updatedAt:true}as const;
/** Public source identity is selected before any private original or price. */
export class ServiceOrderRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 lockCommand(key:string){return advisoryTransactionLock(this.tx,`service-order-command:${this.organizationId}:${key}`);}
 lockOrder(id:string){return advisoryTransactionLock(this.tx,`service-order:${this.organizationId}:${id}`);}
 async clock(){const rows=await this.tx.$queryRaw<Array<{now:Date}>>(Prisma.sql`SELECT clock_timestamp() AS now`);return rows[0].now;}
 head(id:string){return this.tx.serviceOrder.findFirst({where:{organizationId:this.organizationId,id},select:orderHead});}
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
