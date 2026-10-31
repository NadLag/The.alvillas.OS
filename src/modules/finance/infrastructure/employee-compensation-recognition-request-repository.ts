import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";

export type EmployeeRecognitionOutcomeState="SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";
export class EmployeeCompensationRecognitionRequestRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-recognition-request-key:"+key},0))::text`);}
  async lockRequest(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-recognition-request:"+id},0))::text`);}
  find(id:string){return this.tx.employeeCompensationRecognitionRequest.findFirst({where:{organizationId:this.organizationId,id},include:{outcome:true}});}
  byKey(idempotencyKey:string){return this.tx.employeeCompensationRecognitionRequest.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include:{outcome:true}});}
  history(claimId:string){return this.tx.employeeCompensationRecognitionRequest.findMany({where:{organizationId:this.organizationId,claimId},orderBy:{id:"desc"},take:25,include:{outcome:true}});}
  create(input:{submissionId:string;claimId:string;requestedBy:string;idempotencyKey:string;requestFingerprint:string;input:Prisma.InputJsonObject;authorizationCap:AuthorizationCap}){
    return this.tx.employeeCompensationRecognitionRequest.create({data:{...input,organizationId:this.organizationId}});
  }
  outcome(input:{id:string;requestId:string;recognitionId:string|null;state:EmployeeRecognitionOutcomeState;failureCode:string|null}){
    return this.tx.employeeCompensationRecognitionOutcome.create({data:{...input,organizationId:this.organizationId}});
  }
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
