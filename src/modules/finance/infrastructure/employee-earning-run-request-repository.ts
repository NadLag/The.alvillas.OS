import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { employeeEarningRequestSourceFields } from "@/platform/authz/employee-earning-request-resource";
const include={outcome:true,sources:{orderBy:{id:"asc" as const},select:employeeEarningRequestSourceFields}} satisfies Prisma.EmployeeEarningRunRequestInclude;
export type EmployeeEarningRunRequestRecord=Prisma.EmployeeEarningRunRequestGetPayload<{include:typeof include}>;
export type EmployeeEarningRunOutcomeState="SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";
export class EmployeeEarningRunRequestRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-earning-run-request-key:"+key},0))::text`);}
 async lockRequest(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-earning-run-request:"+id},0))::text`);}
 find(id:string){return this.tx.employeeEarningRunRequest.findFirst({where:{organizationId:this.organizationId,id},include});}
 byKey(idempotencyKey:string){return this.tx.employeeEarningRunRequest.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include});}
 create(input:Omit<Prisma.EmployeeEarningRunRequestUncheckedCreateInput,"organizationId"|"sources"|"outcome">){return this.tx.employeeEarningRunRequest.create({data:{...input,organizationId:this.organizationId}});}
 createSources(requestId:string,rows:readonly Omit<Prisma.EmployeeEarningRequestWorkCreateManyInput,"organizationId"|"requestId">[]){return this.tx.employeeEarningRequestWork.createMany({data:rows.map(row=>({...row,organizationId:this.organizationId,requestId}))});}
 createWitnesses(rows:readonly Omit<Prisma.EmployeeEarningRequestHourlyWitnessCreateManyInput,"organizationId">[]){return this.tx.employeeEarningRequestHourlyWitness.createMany({data:rows.map(row=>({...row,organizationId:this.organizationId}))});}
 async createPercentageWitnesses(rows:readonly Omit<Prisma.EmployeeEarningRequestPercentageWitnessCreateManyInput,"organizationId">[]){return this.tx.employeeEarningRequestPercentageWitness.createMany({data:rows.map(row=>({...row,organizationId:this.organizationId}))});}
 outcome(input:Omit<Prisma.EmployeeEarningRunOutcomeUncheckedCreateInput,"organizationId">){return this.tx.employeeEarningRunOutcome.create({data:{...input,organizationId:this.organizationId}});}
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
