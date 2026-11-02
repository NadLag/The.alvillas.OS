import {Prisma} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";

export class RecurringExpenseRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 async lock(){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":recurring-expenses"},0))::text`);}
 async latest(scheduleIds:readonly string[]){const rows=await this.tx.recurringExpenseOccurrence.groupBy({by:["scheduleId"],where:{organizationId:this.organizationId,scheduleId:{in:[...scheduleIds]}},_max:{on:true}});return new Map(rows.map(row=>[row.scheduleId,row._max.on!.toISOString().slice(0,10)]));}
 async properties(ids:readonly string[]){const unique=[...new Set(ids)].sort();if(!unique.length)return[];return this.tx.$queryRaw<Array<{id:string;timezone:string}>>(Prisma.sql`SELECT id::text,timezone FROM property WHERE organization_id=${this.organizationId}::uuid AND id IN (${Prisma.join(unique.map(id=>Prisma.sql`${id}::uuid`))}) AND archived_at IS NULL ORDER BY id FOR SHARE`);}
 history(propertyId:string){return this.tx.recurringExpenseOccurrence.findMany({where:{organizationId:this.organizationId,expense:{propertyId}},orderBy:[{createdAt:"desc"},{id:"desc"}],take:50,select:{id:true,scheduleId:true,on:true,expenseId:true,createdAt:true}});}
 record(input:{scheduleId:string;on:string;configRuleId:string;expenseId:string;createdBy:string;createdAt:Date}){return this.tx.recurringExpenseOccurrence.create({data:{organizationId:this.organizationId,...input,on:new Date(input.on+"T00:00:00Z")}});}
}
