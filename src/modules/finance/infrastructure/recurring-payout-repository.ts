import {Prisma} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
export class RecurringPayoutRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 async lock(){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":recurring-payouts"},0))::text`);}
 eligible(now:Date,take:number){return this.tx.ownerPayout.findMany({where:{organizationId:this.organizationId,state:"APPROVED",eligibleAt:{lte:now},scheduledFor:null},orderBy:[{eligibleAt:"asc"},{id:"asc"}],take,
  select:{id:true,version:true,eligibleAt:true}});}
}
