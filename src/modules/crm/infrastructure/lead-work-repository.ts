import {Prisma,type LeadWorkEntry} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class LeadWorkRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async identity(){const[row]=await this.tx.$queryRaw<Array<{id:string;now:Date}>>`SELECT app_uuid_v7() AS id,clock_timestamp() AS now`;return row;}
  async lockLead(leadId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:work:"+leadId},0))`);}
  async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:work-command:"+commandKey},0))`);}
  current(leadId:string){return this.tx.leadWorkEntry.findFirst({where:{organizationId:this.organizationId,leadId},orderBy:{number:"desc"}});}
  currentAssignment(leadId:string){return this.tx.leadWorkEntry.findFirst({where:{organizationId:this.organizationId,leadId,kind:"ASSIGNMENT"},orderBy:{number:"desc"}});}
  subject(leadId:string,subjectId:string){return this.tx.leadWorkEntry.findFirst({where:{organizationId:this.organizationId,leadId,subjectId},orderBy:{subjectNumber:"desc"}});}
  byNonce(commandKey:string){return this.tx.leadWorkEntry.findFirst({where:{organizationId:this.organizationId,commandKey}});}
  history(leadId:string,before?:number){return this.tx.leadWorkEntry.findMany({where:{organizationId:this.organizationId,leadId,...before?{number:{lt:before}}:{}},orderBy:{number:"desc"},take:21});}
  async account(accountId:string){return this.tx.userAccount.findFirst({where:{organizationId:this.organizationId,id:accountId,status:"ACTIVE",person:{archivedAt:null}},select:{id:true,personId:true,person:{select:{displayName:true}}}});}
  create(input:Omit<Prisma.LeadWorkEntryUncheckedCreateInput,"organizationId">):Promise<LeadWorkEntry>{return this.tx.leadWorkEntry.create({data:{...input,organizationId:this.organizationId}});}
}
