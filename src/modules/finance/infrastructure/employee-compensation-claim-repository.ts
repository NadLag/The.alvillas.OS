import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { employeeCompensationRunLineFields } from "./employee-compensation-run-repository";

const include={run:{include:{lines:{select:employeeCompensationRunLineFields},cancellation:true}},
  costs:{orderBy:{id:"asc" as const},include:{claim:true,runLine:{select:employeeCompensationRunLineFields},property:{select:{cityId:true,regionId:true}}}},claims:true,withdrawal:true,
  approval:{include:{financialStages:{orderBy:{position:"asc" as const}}}}} satisfies Prisma.EmployeeCompensationSubmissionInclude;
export type EmployeeSubmissionRecord=Prisma.EmployeeCompensationSubmissionGetPayload<{include:typeof include}>;

export class EmployeeCompensationClaimRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  currency(code:string){return this.tx.currency.findUnique({where:{code},select:{code:true,minorUnit:true}});}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-submission-key:"+key},0))::text`);}
  async lock(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-submission:"+id},0))::text`);}
  async lockSources(ids:readonly string[]){for(const id of [...new Set(ids)].sort())await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-earned-source:"+id},0))::text`);}
  find(id:string){return this.tx.employeeCompensationSubmission.findFirst({where:{organizationId:this.organizationId,id},include});}
  byKey(key:string){return this.tx.employeeCompensationSubmission.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey:key}},include});}
  listForRun(runId:string,after?:string){return this.tx.employeeCompensationSubmission.findMany({where:{organizationId:this.organizationId,runId,...(after?{id:{lt:after}}:{})},orderBy:{id:"desc"},take:25,
    select:{id:true,runId:true,costOn:true,createdAt:true,withdrawal:{select:{id:true}},approval:{select:{id:true,state:true}},_count:{select:{claims:true}},
      costs:{select:{id:true,propertyId:true,reservationId:true,amount:true,currency:true,timezone:true,runLine:{select:{taskId:true,recordedCompletionAt:true}},property:{select:{cityId:true,regionId:true}}}}}});}
  async workspaceStates(ids:readonly string[]){return this.tx.employeeCompensationSubmission.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]}},select:{id:true,withdrawal:{select:{id:true}},approval:{select:{id:true,state:true}}}});}
  activeSources(ids:readonly string[]){return this.tx.employeeCompensationCost.findMany({where:{organizationId:this.organizationId,completionEventId:{in:[...ids]},
    submission:{withdrawal:null,OR:[{approval:null},{approval:{state:{not:"REJECTED"}}}]}},select:{id:true}});}
  create(input:Omit<Prisma.EmployeeCompensationSubmissionUncheckedCreateInput,"organizationId"|"claims"|"costs"|"approval"|"withdrawal">){return this.tx.employeeCompensationSubmission.create({data:{...input,organizationId:this.organizationId}});}
  createClaims(submissionId:string,personIds:readonly string[]){return this.tx.employeeCompensationClaim.createManyAndReturn({data:[...new Set(personIds)].sort().map(personId=>({organizationId:this.organizationId,submissionId,personId}))});}
  createCosts(costs:readonly Omit<Prisma.EmployeeCompensationCostCreateManyInput,"organizationId">[]){return this.tx.employeeCompensationCost.createMany({data:costs.map(cost=>({...cost,organizationId:this.organizationId}))});}
  withdraw(submissionId:string,withdrawnBy:string,reason:string){return this.tx.employeeCompensationWithdrawal.create({data:{organizationId:this.organizationId,submissionId,withdrawnBy,reason}});}
  event(submissionId:string,type:"EmployeeCompensationSubmitted"|"EmployeeCompensationWithdrawn"){
    return this.tx.outboxEvent.create({data:{organizationId:this.organizationId,type,payload:{submissionId},idempotencyKey:`employee-compensation-submission:${submissionId}:${type}`}});
  }
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
