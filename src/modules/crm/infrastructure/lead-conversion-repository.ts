import {Prisma,type LeadConversion} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

export class LeadConversionRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockLead(leadId:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:conversion:"+leadId},0))`);}
 async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":crm:conversion-command:"+commandKey},0))`);}
 byNonce(commandKey:string){return this.tx.leadConversion.findFirst({where:{organizationId:this.organizationId,commandKey}});}
 byLead(leadId:string){return this.tx.leadConversion.findFirst({where:{organizationId:this.organizationId,leadId}});}
 byId(id:string){return this.tx.leadConversion.findFirst({where:{organizationId:this.organizationId,id}});}
 async validateBirth(){await this.tx.$executeRaw(Prisma.sql`SET CONSTRAINTS lead_conversion_guard IMMEDIATE`);}
 create(input:Omit<Prisma.LeadConversionUncheckedCreateInput,"organizationId">):Promise<LeadConversion>{return this.tx.leadConversion.create({data:{...input,organizationId:this.organizationId}});}
}
