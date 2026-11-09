import {Prisma,type LeadStageRevision} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {leadStageSchema} from "../domain/lead-pipeline";

export class LeadStageRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async clock(){const[row]=await this.tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;return row.now;}
  async lockLead(leadId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:stage:"+leadId},0))`);}
  async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:stage-command:"+commandKey},0))`);}
  lead(leadId:string){return this.tx.lead.findFirst({where:{organizationId:this.organizationId,id:leadId}});}
  current(leadId:string){return this.tx.leadStageRevision.findFirst({where:{organizationId:this.organizationId,leadId},orderBy:{number:"desc"}});}
  byNonce(commandKey:string){return this.tx.leadStageRevision.findFirst({where:{organizationId:this.organizationId,commandKey}});}
  byId(id:string){return this.tx.leadStageRevision.findFirst({where:{organizationId:this.organizationId,id}});}
  proofVersion(id:string){return this.tx.documentVersion.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,documentId:true,number:true,cipherSha256:true,createdAt:true,admission:{select:{sha256:true,contentType:true}},document:{select:{sourceKind:true,sourceId:true,kind:true,typeKey:true,archivedAt:true,revision:true}}}});}
  proofSignatureEvent(id:string){return this.tx.signatureEvent.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,signatureId:true,state:true,providerEvidenceId:true,occurredAt:true,observedAt:true,evidenceHash:true}});}
  providerEvents(ids:readonly string[]){return this.tx.signatureEvent.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]},providerEvidenceId:{not:null}},select:{id:true}});}
  signedArchives(signatureId:string,after?:string){return this.tx.signatureSignedArchive.findMany({where:{organizationId:this.organizationId,signatureId,...after?{id:{gt:after}}:{}},select:{id:true,admittedAt:true},orderBy:{id:"asc"},take:21});}
  proofSignedArchive(id:string){return this.tx.signatureSignedArchive.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,signatureId:true,admittedAt:true,commandHash:true,completionEvidenceId:true,artifacts:{select:{id:true,kind:true,documentId:true,admission:{select:{id:true,sha256:true,contentType:true,version:{select:{id:true,cipherSha256:true}}}}}},evidence:{where:{kind:"SIGNED"},take:1,select:{id:true,observedAt:true,payloadSha256:true}}}});}
  async position(leadId:string){const current=await this.current(leadId);return{stage:current?leadStageSchema.parse(current.toStage):"NEW" as const,revisionId:current?.id??null};}
  history(leadId:string,before?:number){return this.tx.leadStageRevision.findMany({where:{organizationId:this.organizationId,leadId,...before?{number:{lt:before}}:{}},orderBy:{number:"desc"},take:21});}
  create(input:Omit<Prisma.LeadStageRevisionUncheckedCreateInput,"organizationId">):Promise<LeadStageRevision>{return this.tx.leadStageRevision.create({data:{...input,organizationId:this.organizationId}});}
}
