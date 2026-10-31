import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { advisoryTransactionLock } from "@/platform/db/advisory-lock-repository";
import { EmployeeCompensationRepository } from "./employee-compensation-repository";

const include={intervals:{orderBy:{position:"asc" as const}},decision:true} as const;
export class EmployeeWorkTimeRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 task(id:string){return new EmployeeCompensationRepository(this.tx,this.organizationId).completedWork(id);}
 async lockTask(taskId:string){await advisoryTransactionLock(this.tx,`operation:${this.organizationId}:${taskId}`);}
 async lock(taskId:string,personId:string){await advisoryTransactionLock(this.tx,this.organizationId+":employee-work-time:"+taskId+":"+personId);}
 byKey(idempotencyKey:string){return this.tx.employeeWorkTimeEvidence.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include});}
 decisionByKey(idempotencyKey:string){return this.tx.employeeWorkTimeDecision.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}}});}
 evidence(id:string){return this.tx.employeeWorkTimeEvidence.findFirst({where:{organizationId:this.organizationId,id},include});}
 latest(taskId:string,performedByPersonId:string){return this.tx.employeeWorkTimeEvidence.findFirst({where:{organizationId:this.organizationId,taskId,performedByPersonId},orderBy:{version:"desc"},include});}
 page(taskId:string,beforeVersion?:number){return this.tx.employeeWorkTimeEvidence.findMany({where:{organizationId:this.organizationId,taskId,...(beforeVersion?{version:{lt:beforeVersion}}:{})},orderBy:{version:"desc"},take:21,include});}
 actor(id:string){return this.tx.userAccount.findFirst({where:{organizationId:this.organizationId,id,status:"ACTIVE",person:{archivedAt:null}},select:{personId:true}});}
 create(input:Omit<Prisma.EmployeeWorkTimeEvidenceUncheckedCreateInput,"organizationId"|"intervals"|"decision"|"id"|"submittedAt">,intervals:readonly {startsAt:string;endsAt:string;note:string|null}[]){return this.tx.employeeWorkTimeEvidence.create({data:{...input,organizationId:this.organizationId,intervals:{create:intervals.map((row,position)=>({position,startsAt:new Date(row.startsAt),endsAt:new Date(row.endsAt),note:row.note}))}},include});}
 decide(input:Omit<Prisma.EmployeeWorkTimeDecisionUncheckedCreateInput,"organizationId"|"id"|"decidedAt">){return this.tx.employeeWorkTimeDecision.create({data:{...input,organizationId:this.organizationId}});}
 event(type:"EmployeeWorkTimeSubmitted"|"EmployeeWorkTimeDecided",payload:Prisma.InputJsonObject,idempotencyKey:string,occurredAt:Date){return this.tx.outboxEvent.create({data:{organizationId:this.organizationId,type,payload,idempotencyKey,occurredAt}});}
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
}
