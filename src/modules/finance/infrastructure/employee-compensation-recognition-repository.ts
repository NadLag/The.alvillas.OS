import { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";

const include={correction:{include:{lines:{include:{reversalTransaction:{select:{id:true,occurredAt:true,createdBy:true}}}}}},lines:{orderBy:{costId:"asc" as const},include:{transaction:{select:{id:true,occurredAt:true}},periodAdjustment:{select:{id:true,periodId:true,periodEventId:true}}}}} satisfies Prisma.EmployeeCompensationRecognitionInclude;
export class EmployeeCompensationRecognitionRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-recognition-key:"+key},0))::text`);}
  byClaim(claimId:string){return this.tx.employeeCompensationRecognition.findFirst({where:{organizationId:this.organizationId,claimId},include});}
  byKey(idempotencyKey:string){return this.tx.employeeCompensationRecognition.findFirst({where:{organizationId:this.organizationId,idempotencyKey},include});}
  forSubmission(submissionId:string){return this.tx.employeeCompensationRecognition.findMany({where:{organizationId:this.organizationId,submissionId},select:{id:true,claimId:true}});}
  workspaceForSubmission(submissionId:string){return this.tx.employeeCompensationRecognition.findMany({where:{organizationId:this.organizationId,submissionId},orderBy:{id:"asc"},select:{id:true,claimId:true,reason:true,createdAt:true,
    lines:{orderBy:{costId:"asc"},select:{costId:true,transactionId:true,sourceOccurredAt:true,transaction:{select:{occurredAt:true}}}}}});}
  person(id:string){return this.tx.person.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,archivedAt:true}});}
  create(input:{submissionId:string;claimId:string;currentPeriod:boolean;idempotencyKey:string;requestFingerprint:string;reason:string;createdBy:string}){
    return this.tx.employeeCompensationRecognition.create({data:{organizationId:this.organizationId,...input}});
  }
  lines(input:ReadonlyArray<{recognitionId:string;costId:string;transactionId:string;sourceOccurredAt:Date}>){
    return this.tx.employeeCompensationRecognitionLine.createManyAndReturn({data:input.map(line=>({organizationId:this.organizationId,...line}))});
  }
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
