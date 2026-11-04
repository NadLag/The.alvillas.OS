import type {TenantTransaction} from "@/platform/db/tenant";
/** Original booking lifecycle and quoted claims remain native, immutable source records. */
export class GuestDepositApplicationRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async booking(reservationId:string){const[reservation,snapshot]=await Promise.all([
  this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id:reservationId},select:{id:true,organizationId:true,propertyId:true,guestId:true,version:true,status:true,source:true,checkIn:true,checkOut:true,archivedAt:true,property:{select:{id:true,timezone:true}}}}),
  this.tx.reservationFinancialSnapshot.findFirst({where:{organizationId:this.organizationId,reservationId},orderBy:{version:"desc"}})
 ]);if(!reservation||!snapshot)return null;const revision=await this.tx.reservationRevision.findFirst({where:{organizationId:this.organizationId,reservationId,version:reservation.version}});return{reservation,snapshot,revision};}
 accruals(reservationId:string){return this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,reference:"GUEST_ACCOMMODATION_ACCRUAL:"+reservationId,reversesTransactionId:null,reversedByTransactions:{none:{}}},include:{postings:true},orderBy:{id:"desc"},take:2});}
 audit(transactionId:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:transactionId,action:"reservation.revenue.posted"},select:{id:true,actorId:true,after:true,occurredAt:true}});}
}
