import { Prisma, type Lead } from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class LeadRepository {
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async clock():Promise<Date>{const [row]=await this.tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`;return row.now;}
  async lockCommand(key:string):Promise<void>{await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:lead:"+key},0))`);}
  byNonce(commandKey:string):Promise<Lead|null>{return this.tx.lead.findFirst({where:{organizationId:this.organizationId,commandKey}});}
  byId(id:string):Promise<Lead|null>{return this.tx.lead.findFirst({where:{organizationId:this.organizationId,id}});}
  create(input:Omit<Prisma.LeadUncheckedCreateInput,"organizationId">):Promise<Lead>{return this.tx.lead.create({data:{...input,organizationId:this.organizationId}});}
}
