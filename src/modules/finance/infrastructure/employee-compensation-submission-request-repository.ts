import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";

export type EmployeeSubmissionOutcomeState="SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";
export class EmployeeCompensationSubmissionRequestRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-submission-request-key:"+key},0))::text`);}
  async lockRequest(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-submission-request:"+id},0))::text`);}
  find(id:string){return this.tx.employeeCompensationSubmissionRequest.findFirst({where:{organizationId:this.organizationId,id},include:{outcome:true}});}
  byKey(idempotencyKey:string){return this.tx.employeeCompensationSubmissionRequest.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include:{outcome:true}});}
  create(input:{runId:string;requestedBy:string;idempotencyKey:string;requestFingerprint:string;input:Prisma.InputJsonObject;authorizationCap:AuthorizationCap}){
    return this.tx.employeeCompensationSubmissionRequest.create({data:{...input,organizationId:this.organizationId,authorizationCap:input.authorizationCap}});
  }
  outcome(input:{id:string;requestId:string;submissionId:string|null;state:EmployeeSubmissionOutcomeState;failureCode:string|null}){
    return this.tx.employeeCompensationSubmissionOutcome.create({data:{...input,organizationId:this.organizationId}});
  }
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
