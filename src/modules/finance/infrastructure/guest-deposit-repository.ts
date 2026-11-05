import {Prisma} from "@prisma/client";
import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {FinancialTransferRepository} from "./financial-transfer-repository";

export const guestDepositCommandKey=(key:string)=>"guest-deposit:"+key;
const include={postings:{orderBy:{id:"asc"as const},include:{ledgerAccount:{select:{id:true,code:true,name:true,accountType:true,normalSide:true,archivedAt:true,teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}}}},reversedByTransactions:{select:{id:true,createdBy:true,occurredAt:true,reversesTransactionId:true}}}as const;
const totals=z.object({received:z.string(),refunded:z.string(),applied:z.string(),fingerprint:z.string().regex(/^[a-f0-9]{32}$/u),movements:z.string().regex(/^(?:0|[1-9]\d*)$/u)}).strict();

/** The original sealed receipt and its atomic audit are the durable source; no balance row is introduced. */
export class GuestDepositRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 lockCommand(key:string){return new FinancialTransferRepository(this.tx,this.organizationId).lock("guest-deposit-command:"+key);}
 lockSource(id:string){return new FinancialTransferRepository(this.tx,this.organizationId).lock("guest-deposit-source:"+id);}
 async flushOriginalCashProof(){
  // The original finalizer seals only this transaction's new journal. Additional
  // provenance guards remain deferred while the original cash proof is checked.
  await this.tx.$executeRawUnsafe("SET CONSTRAINTS financial_transaction_finish_write IMMEDIATE");
  await this.tx.$executeRawUnsafe("SET CONSTRAINTS guest_cash_admission_guard IMMEDIATE");
 }
 source(reservationId:string){return this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id:reservationId,archivedAt:null},select:{
  id:true,organizationId:true,propertyId:true,guestId:true,version:true,reference:true,status:true,createdAt:true,
  linkedguestId:{select:{id:true,organizationId:true,archivedAt:true}},
  property:{select:{id:true,organizationId:true,archivedAt:true,city:true,cityId:true,region:true,regionId:true,timezone:true}}
 }});}
 policySource(reservationId:string){return this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id:reservationId},select:{source:true}});}
 byCommand(key:string){return this.tx.financialTransaction.findFirst({where:{organizationId:this.organizationId,idempotencyKey:guestDepositCommandKey(key)},include});}
 async receipt(depositId:string){const row=await this.byCommand(depositId);return row?.reference==="GUEST_DEPOSIT:"+depositId&&!row.reversesTransactionId?row:null;}
 journal(id:string){return this.tx.financialTransaction.findFirst({where:{organizationId:this.organizationId,id},include});}
 async externalCaptureSource(depositId:string){const row=await this.tx.externalPaymentIntent.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey:depositId}},select:{capture:{select:{id:true}}}});return row?.capture??null;}
 externalRefundByKey(idempotencyKey:string){return this.tx.externalPaymentRefundIntent.findUnique({where:{organizationId_idempotencyKey:{organizationId:this.organizationId,idempotencyKey}},include:{capture:true,identity:{include:{observations:{include:{settlement:true},orderBy:[{providerUpdatedAt:"desc"},{id:"desc"}],take:1}}}}});}
 externalRefundReview(intentId:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:intentId,action:"finance.external_payment.refund_review_retained"},select:{actorId:true,after:true,reason:true}});}
 firstCompletedExternalRefund(identityId:string){return this.tx.externalPaymentRefundEvidence.findFirst({where:{organizationId:this.organizationId,identityId,state:"COMPLETED"},orderBy:[{providerUpdatedAt:"asc"},{id:"asc"}]});}
 async reservedExternalRefunds(depositId:string){return(await this.tx.$queryRaw<Array<{amount:string}>>`SELECT app_external_refund_reserved(${this.organizationId}::uuid,${depositId}::uuid)::text AS amount`)[0].amount;}
 cashSource(id:string){return this.tx.cashCollection.findFirst({where:{organizationId:this.organizationId,id},include:{transaction:{include},property:{select:{city:true,cityId:true,region:true,regionId:true}}}});}
 cashSources(reservationId:string,before?:string){return this.tx.cashCollection.findMany({where:{organizationId:this.organizationId,reservationId,...before?{id:{lt:before}}:{}},orderBy:{id:"desc"},take:51,include:{transaction:{include}}});}
 cashBookingRevision(reservationId:string,recordedAt:Date){return this.tx.reservationRevision.findFirst({where:{organizationId:this.organizationId,reservationId,createdAt:{lte:recordedAt}},orderBy:{version:"desc"},select:{id:true,after:true}});}
 async cashRemaining(collectionId:string,accountId:string,currency:string){const row=(await this.cashPositions([{collectionId,accountId,currency}])).get(collectionId);if(!row)throw Error("Actual cash source position required");return row;}
 async cashPositions(entries:readonly{collectionId:string;accountId:string;currency:string}[]){
  if(!entries.length)return new Map<string,{amount:string;fingerprint:string}>();
  const rows=await this.tx.$queryRaw<Array<{collectionId:string;amount:string;fingerprint:string}>>(Prisma.sql`WITH requested(collection_id,account_id,currency) AS(VALUES ${Prisma.join(entries.map(row=>Prisma.sql`(${row.collectionId}::text,${row.accountId}::uuid,${row.currency}::text)`))}) SELECT r.collection_id AS "collectionId",coalesce(sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END),0)::text AS amount,md5(coalesce(string_agg(p.id::text||':'||p.side||':'||p.amount::text,',' ORDER BY p.id),'')) AS fingerprint FROM requested r LEFT JOIN posting p ON p.organization_id=${this.organizationId}::uuid AND p.ledger_account_id=r.account_id AND p.currency=r.currency AND(p.dimensions ? 'cash_collection_id' OR p.dimensions ? 'cashCollectionId') AND lower(coalesce(p.dimensions->>'cash_collection_id',p.dimensions->>'cashCollectionId'))=r.collection_id GROUP BY r.collection_id`);
  return new Map(rows.map(({collectionId,...row})=>[collectionId,row]));
 }
 audit(id:string,action:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:id,action},orderBy:{id:"asc"},select:{id:true,actorId:true,reason:true,after:true,occurredAt:true}});}
 commandAudit(id:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:id,action:{in:["finance.guest_deposit.received","finance.guest_deposit.refunded","finance.guest_deposit.applied","finance.guest_deposit.reversed"]}},orderBy:{id:"asc"},select:{id:true,actorId:true,reason:true,after:true,occurredAt:true}});}
 audits(ids:string[]){return this.tx.auditLog.findMany({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:{in:ids},action:{in:["finance.guest_deposit.received","finance.guest_deposit.refunded","finance.guest_deposit.applied","finance.guest_deposit.reversed","finance.guest_deposit.application_reallocated"]}},select:{resourceId:true,actorId:true,reason:true,after:true}});}
 receiptPage(input:{before?:string;query:string}){return this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,reference:{startsWith:"GUEST_DEPOSIT:"},reversesTransactionId:null,...input.before?{id:{lt:input.before}}:{},...input.query?{description:{contains:input.query,mode:"insensitive"}}:{}},orderBy:{id:"desc"},take:51,include});}
 sourcePage(input:{before?:string;query:string}){return this.tx.reservation.findMany({where:{organizationId:this.organizationId,archivedAt:null,guestId:{not:null},property:{archivedAt:null},linkedguestId:{archivedAt:null},...input.before?{id:{lt:input.before}}:{},...input.query?{OR:[{reference:{contains:input.query,mode:"insensitive"}},{property:{name:{contains:input.query,mode:"insensitive"}}}]}:{}},orderBy:{id:"desc"},take:51,select:{id:true,reference:true,propertyId:true,guestId:true,property:{select:{id:true,name:true,city:true,cityId:true,region:true,regionId:true}},linkedguestId:{select:{id:true,displayName:true}}}});}
 async metadata(entries:readonly{propertyId:string;reservationId:string;guestId:string}[]){const[properties,reservations,guests]=await Promise.all([
  this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.propertyId))]}},select:{id:true,name:true,city:true,cityId:true,region:true,regionId:true}}),
  this.tx.reservation.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.reservationId))]}},select:{id:true,reference:true,propertyId:true}}),
  this.tx.guestRecord.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(entries.map(row=>row.guestId))]}},select:{id:true,displayName:true}})
 ]);return{properties:new Map(properties.map(row=>[row.id,row])),reservations:new Map(reservations.map(row=>[row.id,row])),guests:new Map(guests.map(row=>[row.id,row]))};}
 accounts(codes:string[]){return this.tx.ledgerAccount.findMany({where:{organizationId:this.organizationId,code:{in:codes}},orderBy:{id:"desc"},select:{id:true,code:true,name:true,accountType:true,normalSide:true,archivedAt:true,teamWallet:{select:{id:true,personId:true,person:{select:{archivedAt:true}}}}}});}
 history(depositId:string,before?:string){return this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,...before?{id:{lt:before}}:{},
  postings:{some:{organizationId:this.organizationId,dimensions:{path:["deposit_id"],equals:depositId}}}
 },orderBy:{id:"desc"},take:51,include});}
 async movements(depositId:string,liabilityAccountId:string,currency:string){return totals.parse((await this.positions([{depositId,liabilityAccountId,currency}])).get(depositId));}
 async positions(entries:readonly{depositId:string;liabilityAccountId:string;currency:string}[]){
  if(!entries.length)return new Map<string,z.infer<typeof totals>>();
  const rows=await this.tx.$queryRaw<Array<z.infer<typeof totals>&{depositId:string}>>(Prisma.sql`WITH requested(deposit_id,claim_id,currency) AS(VALUES ${Prisma.join(entries.map(row=>Prisma.sql`(${row.depositId}::text,${row.liabilityAccountId}::uuid,${row.currency}::text)`))}) SELECT r.deposit_id AS "depositId",
   COALESCE(sum(CASE WHEN p.dimensions->>'deposit_operation' IN ('RECEIPT','CASH_ADMISSION') THEN CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS received,
   COALESCE(sum(CASE WHEN p.dimensions->>'deposit_operation'='REFUND' THEN CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS refunded,
   COALESCE(sum(CASE WHEN p.dimensions->>'deposit_operation'='APPLICATION' THEN CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS applied,
   md5(COALESCE(string_agg(p.id::text||':'||p.transaction_id::text||':'||p.side||':'||p.amount::text,',' ORDER BY p.id),'')) AS fingerprint,count(p.id)::text AS movements
   FROM requested r LEFT JOIN posting p ON p.organization_id=${this.organizationId}::uuid AND p.ledger_account_id=r.claim_id AND p.currency=r.currency
   AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=r.deposit_id GROUP BY r.deposit_id`);
  return new Map(rows.map(({depositId,...row})=>[depositId,totals.parse(row)]));
 }
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");}
}
