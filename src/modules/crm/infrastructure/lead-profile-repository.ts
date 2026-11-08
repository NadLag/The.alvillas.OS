import {Prisma,type LeadProfileRevision} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class LeadProfileRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockLead(leadId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:profile:"+leadId},0))`);}
  async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:profile-command:"+commandKey},0))`);}
  current(leadId:string){return this.tx.leadProfileRevision.findFirst({where:{organizationId:this.organizationId,leadId},orderBy:{number:"desc"}});}
  byNonce(commandKey:string){return this.tx.leadProfileRevision.findFirst({where:{organizationId:this.organizationId,commandKey}});}
  history(leadId:string,before?:number){return this.tx.leadProfileRevision.findMany({where:{organizationId:this.organizationId,leadId,...before?{number:{lt:before}}:{}},orderBy:{number:"desc"},take:21});}
  create(input:Omit<Prisma.LeadProfileRevisionUncheckedCreateInput,"organizationId">):Promise<LeadProfileRevision>{return this.tx.leadProfileRevision.create({data:{...input,organizationId:this.organizationId}});}
}
