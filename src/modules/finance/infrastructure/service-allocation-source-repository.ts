import type {TenantTransaction} from "@/platform/db/tenant";

/** Original native collection and journal identities; no estimated service or mutable balance source. */
export class ServiceAllocationSourceRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){}
 collection(id:string){return this.tx.cashCollection.findFirst({where:{organizationId:this.organizationId,id},select:{
  id:true,organizationId:true,taskId:true,propertyId:true,reservationId:true,collectorUserAccountId:true,collectorPersonId:true,custodyAccountId:true,transactionId:true,amount:true,currency:true,payer:true,purpose:true,recordedAt:true,provenance:true,
  currencyRef:{select:{code:true,minorUnit:true}},property:{select:{id:true,organizationId:true,archivedAt:true,timezone:true,city:true,region:true,cityId:true,regionId:true}},
  transaction:{select:{id:true,organizationId:true,sealed:true,occurredAt:true,reversesTransactionId:true,reversedByTransactions:{select:{id:true},orderBy:{id:"asc"}},postings:{orderBy:{id:"asc"},select:{id:true,organizationId:true,transactionId:true,ledgerAccountId:true,side:true,amount:true,currency:true,bucket:true,dimensions:true,ledgerAccount:{select:{id:true,organizationId:true,code:true,accountType:true,normalSide:true,archivedAt:true}}}}}}
 }});}
}
