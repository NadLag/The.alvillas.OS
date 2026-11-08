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
  subjectHeads(leadId:string,subjectIds:readonly string[]){return this.tx.leadWorkEntry.groupBy({by:["subjectId"],where:{organizationId:this.organizationId,leadId,subjectId:{in:[...subjectIds]}},_max:{subjectNumber:true}});}
  async account(accountId:string){return this.tx.userAccount.findFirst({where:{organizationId:this.organizationId,id:accountId,status:"ACTIVE",person:{archivedAt:null}},select:{id:true,personId:true,person:{select:{displayName:true}}}});}
  accounts(query:string,before?:string){return this.tx.userAccount.findMany({where:{organizationId:this.organizationId,status:"ACTIVE",...before?{id:{gt:before}}:{},person:{archivedAt:null,displayName:{contains:query,mode:"insensitive"}}},select:{id:true,personId:true,person:{select:{displayName:true}}},orderBy:{id:"asc"},take:101});}
  accountsByIds(ids:readonly string[]){return this.tx.userAccount.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]},status:"ACTIVE",person:{archivedAt:null}},select:{id:true,personId:true,person:{select:{displayName:true}}}});}
  reminder(id:string,now:Date){return this.tx.leadWorkEntry.findFirst({where:{organizationId:this.organizationId,id,kind:"REMINDER",reminderState:"OPEN",dueAt:{lte:now},nextSubject:{none:{organizationId:this.organizationId}}},include:{lead:{include:{stageRevisions:{orderBy:{number:"desc"},take:1},workEntries:{where:{kind:"ASSIGNMENT"},orderBy:{number:"desc"},take:1}}}}});}
  dueReminders(now:Date,before?:string){return this.tx.$queryRaw<Array<{id:string;leadId:string}>>(Prisma.sql`SELECT w.id,w.lead_id AS "leadId" FROM lead_work_entry w WHERE w.organization_id=${this.organizationId}::uuid AND w.kind='REMINDER' AND w.reminder_state='OPEN' AND w.due_at<=${now}
    ${before?Prisma.sql`AND w.id>${before}::uuid`:Prisma.empty}
    AND NOT EXISTS(SELECT 1 FROM lead_work_entry n WHERE n.organization_id=w.organization_id AND n.previous_subject_id=w.id)
    AND NOT EXISTS(SELECT 1 FROM outbox_event e WHERE e.organization_id=w.organization_id AND e.idempotency_key='crm.lead.reminder:'||w.id::text)
    ORDER BY w.id LIMIT 101`);}
  create(input:Omit<Prisma.LeadWorkEntryUncheckedCreateInput,"organizationId">):Promise<LeadWorkEntry>{return this.tx.leadWorkEntry.create({data:{...input,organizationId:this.organizationId}});}
}
