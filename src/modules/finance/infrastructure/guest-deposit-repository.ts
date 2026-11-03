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
 source(reservationId:string){return this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id:reservationId,archivedAt:null},select:{
  id:true,organizationId:true,propertyId:true,guestId:true,version:true,reference:true,status:true,createdAt:true,
  linkedguestId:{select:{id:true,organizationId:true,archivedAt:true}},
  property:{select:{id:true,organizationId:true,archivedAt:true,city:true,cityId:true,region:true,regionId:true,timezone:true}}
 }});}
 policySource(reservationId:string){return this.tx.reservation.findFirst({where:{organizationId:this.organizationId,id:reservationId},select:{source:true}});}
 byCommand(key:string){return this.tx.financialTransaction.findFirst({where:{organizationId:this.organizationId,idempotencyKey:guestDepositCommandKey(key)},include});}
 async receipt(depositId:string){const row=await this.byCommand(depositId);return row?.reference==="GUEST_DEPOSIT:"+depositId&&!row.reversesTransactionId?row:null;}
 journal(id:string){return this.tx.financialTransaction.findFirst({where:{organizationId:this.organizationId,id},include});}
 audit(id:string,action:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:id,action},orderBy:{id:"asc"},select:{id:true,actorId:true,reason:true,after:true,occurredAt:true}});}
 commandAudit(id:string){return this.tx.auditLog.findFirst({where:{organizationId:this.organizationId,resourceType:"financial_transaction",resourceId:id,action:{in:["finance.guest_deposit.received","finance.guest_deposit.refunded","finance.guest_deposit.reversed"]}},orderBy:{id:"asc"},select:{id:true,actorId:true,reason:true,after:true,occurredAt:true}});}
 history(depositId:string,before?:string){return this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,...before?{id:{lt:before}}:{},
  postings:{some:{organizationId:this.organizationId,dimensions:{path:["deposit_id"],equals:depositId}}}
 },orderBy:{id:"desc"},take:51,include});}
 async movements(depositId:string,liabilityAccountId:string,currency:string){
  const[row]=await this.tx.$queryRaw<Array<z.infer<typeof totals>>>(Prisma.sql`SELECT
   COALESCE(sum(CASE WHEN p.dimensions->>'deposit_operation'='RECEIPT' THEN CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS received,
   COALESCE(sum(CASE WHEN p.dimensions->>'deposit_operation'='REFUND' THEN CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS refunded,
   COALESCE(sum(CASE WHEN p.dimensions->>'deposit_operation'='APPLICATION' THEN CASE p.side WHEN 'DEBIT' THEN p.amount ELSE -p.amount END ELSE 0 END),0)::text AS applied,
   md5(COALESCE(string_agg(p.id::text||':'||p.transaction_id::text||':'||p.side||':'||p.amount::text,',' ORDER BY p.id),'')) AS fingerprint,count(*)::text AS movements
   FROM posting p WHERE p.organization_id=${this.organizationId}::uuid AND p.ledger_account_id=${liabilityAccountId}::uuid AND p.currency=${currency}
   AND p.dimensions->>'source'='GUEST_DEPOSIT' AND p.dimensions->>'deposit_id'=${depositId}`);
  return totals.parse(row);
 }
 async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");}
}
