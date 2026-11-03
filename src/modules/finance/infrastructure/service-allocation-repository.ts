import {Prisma} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";

export type ServiceProviderKind="SUPPLIER_INVOICE_LINE"|"EMPLOYEE_COST";

/** Append-only admission and provider references; original payables and collected money remain canonical. */
export class ServiceAllocationRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 async lockCollection(collectionId:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+':service-allocation-source:'+collectionId},0))::text`);}
 async lockRequest(nonce:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+':service-allocation-command:'+nonce},0))::text`);}
 async lockProvider(kind:ServiceProviderKind,id:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+':service-allocation-provider:'+kind+':'+id},0))::text`);}
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");}
 sourceForCollection(cashCollectionId:string){return this.tx.serviceFinancialSource.findUnique({where:{organizationId_cashCollectionId:{organizationId:this.organizationId,cashCollectionId}}});}
 source(id:string){return this.tx.serviceFinancialSource.findUnique({where:{organizationId_id:{organizationId:this.organizationId,id}},include:{collection:{select:{propertyId:true,reservationId:true,amount:true,currency:true,taskId:true,recordedAt:true,property:{select:{city:true,region:true,cityId:true,regionId:true,archivedAt:true}}}}}});}
 registerSource(data:Omit<Prisma.ServiceFinancialSourceUncheckedCreateInput,"organizationId">){return this.tx.serviceFinancialSource.create({data:{...data,organizationId:this.organizationId}});}
 admissionByNonce(idempotencyKey:string){return this.tx.serviceAllocationAdmission.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include:{source:true,providerParts:{orderBy:{componentKey:"asc"}}}});}
 admission(id:string){return this.tx.serviceAllocationAdmission.findUnique({where:{organizationId_id:{organizationId:this.organizationId,id}},include:{source:true,providerParts:{orderBy:{componentKey:"asc"}}}});}
 latestAdmission(sourceId:string){return this.tx.serviceAllocationAdmission.findFirst({where:{organizationId:this.organizationId,sourceId},orderBy:{version:"desc"}});}
 appendAdmission(data:Omit<Prisma.ServiceAllocationAdmissionUncheckedCreateInput,"organizationId"|"providerParts">){return this.tx.serviceAllocationAdmission.create({data:{...data,organizationId:this.organizationId}});}
 appendProviderPart(data:Omit<Prisma.ServiceAllocationProviderPartUncheckedCreateInput,"organizationId">){return this.tx.serviceAllocationProviderPart.create({data:{...data,organizationId:this.organizationId}});}
 admissionHistory(sourceId:string,beforeVersion?:number){return this.tx.serviceAllocationAdmission.findMany({where:{organizationId:this.organizationId,sourceId,...beforeVersion?{version:{lt:beforeVersion}}:{}},orderBy:{version:"desc"},take:51,include:{providerParts:{orderBy:{componentKey:"asc"}}}});}
 binding(id:string){return this.tx.serviceAllocationProviderBinding.findUnique({where:{organizationId_id:{organizationId:this.organizationId,id}}});}
  bindingByNonce(idempotencyKey:string){return this.tx.serviceAllocationProviderBinding.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}}});}
 bindings(ids:readonly string[]){return this.tx.serviceAllocationProviderBinding.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},orderBy:{id:"asc"}});}
 latestBinding(kind:ServiceProviderKind,id:string){return this.tx.serviceAllocationProviderBinding.findFirst({where:{organizationId:this.organizationId,...kind==="SUPPLIER_INVOICE_LINE"?{supplierInvoiceLineId:id}:{employeeCostId:id}},orderBy:{version:"desc"}});}
 appendBinding(data:Omit<Prisma.ServiceAllocationProviderBindingUncheckedCreateInput,"organizationId">){return this.tx.serviceAllocationProviderBinding.create({data:{...data,organizationId:this.organizationId}});}
 async bindingHistory(sourceId:string,beforeId?:string){
  const rows=await this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT id FROM service_allocation_provider_binding WHERE organization_id=${this.organizationId}::uuid AND source_id=${sourceId}::uuid
   ${beforeId?Prisma.sql`AND(created_at,id)<(SELECT created_at,id FROM service_allocation_provider_binding WHERE organization_id=${this.organizationId}::uuid AND source_id=${sourceId}::uuid AND id=${beforeId}::uuid)`:Prisma.empty}
   ORDER BY created_at DESC,id DESC LIMIT 51`);
  return this.tx.serviceAllocationProviderBinding.findMany({where:{organizationId:this.organizationId,sourceId,id:{in:rows.map(row=>row.id)}},orderBy:[{createdAt:"desc"},{id:"desc"}]});
 }
 propertyOwners(propertyId:string){return this.tx.propertyOwner.findMany({where:{organizationId:this.organizationId,propertyId,archivedAt:null,owner:{archivedAt:null}},orderBy:{ownerId:"asc"},select:{id:true,ownerId:true,shareBps:true,owner:{select:{id:true,organizationId:true,displayName:true,archivedAt:true}}}});}
 sourceResources(ids:readonly string[]){return this.tx.serviceFinancialSource.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,collection:{select:{propertyId:true,reservationId:true,taskId:true,amount:true,currency:true,property:{select:{city:true,region:true,cityId:true,regionId:true}}}}}});}
}
