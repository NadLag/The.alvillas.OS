import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";

export type EmployeeMonthlyRunOutcomeState="SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";
export class EmployeeMonthlyRunRequestRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-monthly-run-request-key:"+key},0))::text`);}
  async lockRequest(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-monthly-run-request:"+id},0))::text`);}
  find(id:string){return this.tx.employeeMonthlyRunRequest.findFirst({where:{organizationId:this.organizationId,id},include:{outcome:true}});}
  byKey(idempotencyKey:string){return this.tx.employeeMonthlyRunRequest.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include:{outcome:true}});}
  create(input:{requestedBy:string;idempotencyKey:string;requestFingerprint:string;reviewedSourceFingerprint:string;policyRuleId:string;input:Prisma.InputJsonObject;review:Prisma.InputJsonObject;authorizationCap:AuthorizationCap}){return this.tx.employeeMonthlyRunRequest.create({data:{...input,organizationId:this.organizationId}});}
  async outcome(input:{id:string;requestId:string;runId:string|null;state:EmployeeMonthlyRunOutcomeState;failureCode:string|null}){return this.tx.employeeMonthlyRunOutcome.create({data:{...input,organizationId:this.organizationId}});}
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
