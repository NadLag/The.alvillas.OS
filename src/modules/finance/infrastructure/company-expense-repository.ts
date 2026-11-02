import {Prisma} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
import {LedgerCalendarRepository} from "./ledger-calendar-repository";

export class CompanyExpenseRepository extends LedgerCalendarRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){super(tx,organizationId);}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 async lock(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":company-expense:"+key},0))::text`);}
 async configuredCalendar(){await this.tx.$queryRaw`SELECT organization_id FROM organization_profile WHERE organization_id=${this.organizationId}::uuid FOR SHARE`;return this.settings();}
 byNonce(idempotencyKey:string){return this.tx.companyExpensePlan.findFirst({where:{organizationId:this.organizationId,idempotencyKey},include:{revisions:{orderBy:{version:"asc"},take:1}}});}
 latest(id:string){return this.tx.companyExpenseRevision.findFirst({where:{organizationId:this.organizationId,companyExpenseId:id},orderBy:{version:"desc"}});}
 async lockPlanRead(id:string){await this.tx.$queryRaw`SELECT id FROM company_expense_plan WHERE organization_id=${this.organizationId}::uuid AND id=${id}::uuid FOR SHARE`;}
 history(id:string,beforeVersion?:number){return this.tx.companyExpenseRevision.findMany({where:{organizationId:this.organizationId,companyExpenseId:id,...beforeVersion?{version:{lt:beforeVersion}}:{}},orderBy:{version:"desc"},take:51});}
 create(input:{idempotencyKey:string;createdBy:string;createdAt:Date}){return this.tx.companyExpensePlan.create({data:{organizationId:this.organizationId,...input}});}
 append(data:Omit<Prisma.CompanyExpenseRevisionUncheckedCreateInput,"organizationId">){return this.tx.companyExpenseRevision.create({data:{...data,organizationId:this.organizationId}});}
 async latestOccurrences(scheduleIds:readonly string[]){const rows=await this.tx.recurringCompanyExpenseOccurrence.groupBy({by:["scheduleId"],where:{organizationId:this.organizationId,scheduleId:{in:[...scheduleIds]}},_max:{on:true}});return new Map(rows.map(row=>[row.scheduleId,row._max.on!.toISOString().slice(0,10)]));}
 recordOccurrence(input:{scheduleId:string;on:string;configRuleId:string;companyExpenseId:string;createdBy:string;createdAt:Date}){return this.tx.recurringCompanyExpenseOccurrence.create({data:{organizationId:this.organizationId,...input,on:new Date(input.on+"T00:00:00Z")}});}
}
