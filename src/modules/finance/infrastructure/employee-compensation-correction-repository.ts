import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

const include={lines:{orderBy:{costId:"asc" as const}}} satisfies Prisma.EmployeeCompensationCorrectionInclude;
export class EmployeeCompensationCorrectionRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockKey(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":employee-correction-key:"+key},0))::text`);}
 byClaim(claimId:string){return this.tx.employeeCompensationCorrection.findUnique({where:{organizationId_claimId:{organizationId:this.organizationId,claimId}},include});}
 byKey(idempotencyKey:string){return this.tx.employeeCompensationCorrection.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include});}
 create(input:{submissionId:string;claimId:string;recognitionId:string;idempotencyKey:string;requestFingerprint:string;reason:string;createdBy:string}){return this.tx.employeeCompensationCorrection.create({data:{...input,organizationId:this.organizationId}});}
 lines(input:readonly {correctionId:string;costId:string;recognitionLineId:string;originalTransactionId:string;reversalTransactionId:string}[]){return this.tx.employeeCompensationCorrectionLine.createManyAndReturn({data:input.map(line=>({...line,organizationId:this.organizationId}))});}
}
