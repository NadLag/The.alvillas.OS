import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

/** Native booking evidence and derived application movements; no receivable or balance is manufactured. */
export class GuestAccommodationApplicationRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async source(reservationId:string){
  const[reservation,financialSnapshot,commissions,checkout,confirmation]=await Promise.all([
   this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id:reservationId,archivedAt:null},select:{id:true,reference:true,propertyId:true,guestId:true,version:true,status:true,source:true,createdAt:true,checkIn:true,checkOut:true,property:{select:{id:true,archivedAt:true,timezone:true,city:true,cityId:true,region:true,regionId:true}}}}),
   this.tx.reservationFinancialSnapshot.findFirst({where:{organizationId:this.organizationId,reservationId},orderBy:{version:"desc"}}),
   this.tx.commissionSnapshot.findMany({where:{organizationId:this.organizationId,reservationId},orderBy:{ownerId:"asc"}}),
   this.tx.reservationRevision.findFirst({where:{organizationId:this.organizationId,reservationId,operation:{in:["TRANSITION","EARLY_CHECKOUT"]},after:{path:["status"],equals:"CHECKED_OUT"}},orderBy:{version:"desc"},select:{id:true,version:true,before:true,after:true,createdAt:true,createdBy:true}}),
   this.tx.reservationRevision.findFirst({where:{organizationId:this.organizationId,reservationId,operation:"CONFIRM"},orderBy:{version:"asc"},select:{id:true,version:true,after:true,createdAt:true,createdBy:true}})
  ]);
  return reservation&&financialSnapshot?{reservation,financialSnapshot,commissions,checkout,confirmation}:null;
 }
 async position(reservationId:string,currency:string){
  const[row]=await this.tx.$queryRaw<Array<{applied:string;fingerprint:string;movements:string}>>(Prisma.sql`SELECT coalesce(sum(CASE WHEN a.code ~ '^GUEST_(PREPAYMENT|DEPOSIT)(_[A-Z0-9_]+)?$' AND a.normal_side='CREDIT' AND p.dimensions->>'deposit_operation'='APPLICATION' THEN CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS applied,md5(coalesce(string_agg(p.id::text||':'||p.transaction_id::text||':'||p.side||':'||p.amount::text||':'||p.currency,',' ORDER BY p.id),'')) AS fingerprint,count(p.id)::text AS movements FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${currency} AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'reservation_id'=${reservationId} AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT' AND p.dimensions->>'deposit_operation' IN('APPLICATION','APPLICATION_ADJUSTMENT')`);
  return row;
 }
 ownerVector(reservationId:string,currency:string){
  return this.tx.$queryRaw<Array<{ledgerAccountId:string;currency:string;bucket:string|null;dimensions:unknown;debit:string}>>(Prisma.sql`SELECT p.ledger_account_id AS "ledgerAccountId",p.currency,p.bucket,(p.dimensions-ARRAY['deposit_id','deposit_kind','deposit_operation','deposit_application_id','original_transaction_id','guest_id','application_source','booking_source','allocation_parent_transaction_id'])||jsonb_build_object('source',p.dimensions->>'booking_source') AS dimensions,sum(CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END)::text AS debit FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${currency} AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'reservation_id'=${reservationId} AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT' AND p.dimensions->>'deposit_operation' IN('APPLICATION','APPLICATION_ADJUSTMENT') AND a.code IN('OWNER_PAYABLE','ALVILLAS_COMMISSION_REVENUE') GROUP BY p.ledger_account_id,p.currency,p.bucket,(p.dimensions-ARRAY['deposit_id','deposit_kind','deposit_operation','deposit_application_id','original_transaction_id','guest_id','application_source','booking_source','allocation_parent_transaction_id'])||jsonb_build_object('source',p.dimensions->>'booking_source') ORDER BY p.ledger_account_id,p.currency,p.bucket,dimensions`);
 }
}
