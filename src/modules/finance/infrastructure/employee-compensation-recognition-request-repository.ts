import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import type { AuthorizationCap } from "@/platform/authz/authorization-cap";

export type EmployeeRecognitionOutcomeState="SUCCEEDED"|"DENIED"|"CONFLICT"|"FAILED";
export type EmployeeRecognitionOperation="RECOGNIZE"|"REVERSE";
export class EmployeeCompensationRecognitionRequestRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-recognition-request-key:"+key},0))::text`);}
  async lockRequest(id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-recognition-request:"+id},0))::text`);}
  find(id:string){return this.tx.employeeCompensationRecognitionRequest.findFirst({where:{organizationId:this.organizationId,id},include:{outcome:true}});}
  byKey(idempotencyKey:string){return this.tx.employeeCompensationRecognitionRequest.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include:{outcome:true}});}
  async history(claimId:string,requestedBy:string,before?:string,operation:EmployeeRecognitionOperation="RECOGNIZE"){return this.tx.employeeCompensationRecognitionRequest.findMany({where:{organizationId:this.organizationId,claimId,requestedBy,operation},...(before?{cursor:{id:before},skip:1}:{}),orderBy:[{requestedAt:"desc"},{id:"desc"}],take:11,
    select:{id:true,submissionId:true,claimId:true,operation:true,originalRecognitionId:true,input:true,requestedAt:true,outcome:{select:{state:true,recognitionId:true,correctionId:true,failureCode:true}}}});}
  pendingClaims(claimIds:readonly string[],operation:EmployeeRecognitionOperation="RECOGNIZE"){return this.tx.employeeCompensationRecognitionRequest.findMany({where:{organizationId:this.organizationId,claimId:{in:[...claimIds]},operation,outcome:null},orderBy:{id:"asc"},
    select:{id:true,submissionId:true,claimId:true,operation:true,originalRecognitionId:true,requestedBy:true,outcome:{select:{state:true,recognitionId:true,correctionId:true,failureCode:true}}}});}
  create(input:{submissionId:string;claimId:string;requestedBy:string;idempotencyKey:string;requestFingerprint:string;input:Prisma.InputJsonObject;authorizationCap:AuthorizationCap;operation?:EmployeeRecognitionOperation;originalRecognitionId?:string|null}){
    return this.tx.employeeCompensationRecognitionRequest.create({data:{...input,organizationId:this.organizationId}});
  }
  outcome(input:{id:string;requestId:string;recognitionId:string|null;correctionId?:string|null;state:EmployeeRecognitionOutcomeState;failureCode:string|null}){
    return this.tx.employeeCompensationRecognitionOutcome.create({data:{...input,organizationId:this.organizationId}});
  }
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
