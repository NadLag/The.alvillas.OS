import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {serviceCatalogRuleKey} from "@/platform/config/service-catalog-policy";

/** Catalog content remains exclusively in the canonical ConfigRule repository. */
export class ServiceCatalogRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async lockCommand(commandKey:string){await this.tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`service-catalog:${this.organizationId}:${commandKey}`},0))`);}
 history(propertyId:string,afterVersion?:number){
  return this.tx.configRule.findMany({where:{organizationId:this.organizationId,key:serviceCatalogRuleKey,scopeType:"property",scopeId:propertyId,archivedAt:null,...afterVersion?{version:{lt:afterVersion}}:{}},orderBy:[{version:"desc"},{id:"desc"}],take:21,select:{id:true,version:true,lifecycle:true,createdAt:true,effectiveFrom:true,effectiveTo:true,createdBy:true,reason:true}});
 }
}
