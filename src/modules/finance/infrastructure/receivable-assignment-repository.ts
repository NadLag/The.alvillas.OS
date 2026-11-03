import {Prisma} from "@prisma/client";
import type {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {EmployeePercentageSourceRepository} from "./employee-percentage-source-repository";
import type {receivablePartyKind} from "../domain/receivable-assignment";

import {receivableOriginalSnapshot} from "../domain/receivable-original-snapshot";
export {receivableOriginalSnapshot} from "../domain/receivable-original-snapshot";

export class ReceivableAssignmentRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  async lockIntent(key:string){await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":receivable-intent:"+key},0))::text`);}
  async commandKind(key:string){const[row]=await this.tx.$queryRaw<Array<{kind:string|null}>>(Prisma.sql`SELECT app_receivable_command_kind(${this.organizationId}::uuid,${key}::uuid) kind`);return row?.kind??null;}
  async collectedAmount(assignmentId:string,currency:string){const[row]=await this.tx.$queryRaw<Array<{collected:string}>>(Prisma.sql`SELECT collected::text FROM app_receivable_collection_movements(${this.organizationId}::uuid,${assignmentId}::uuid,${currency})`);if(!row)throw Error("Actual receivable movement aggregate required");return row.collected;}
  async lockSource(postingId:string,journalId:string){
    await new EmployeePercentageSourceRepository(this.tx,this.organizationId).lockJournals([journalId]);
    await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":receivable-source:"+postingId},0))::text`);
  }
  async original(postingId:string){
    const[row]=await this.tx.$queryRaw<Array<{source:Prisma.JsonValue|null;eligible:boolean}>>(Prisma.sql`
      SELECT app_receivable_original_source(${this.organizationId}::uuid,${postingId}::uuid) AS source,
       EXISTS(SELECT 1 FROM posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
        WHERE p.organization_id=${this.organizationId}::uuid AND p.id=${postingId}::uuid AND t.occurred_at<=clock_timestamp()) AS eligible`);
    if(!row?.source)return null;const snapshot=receivableOriginalSnapshot.parse(row.source);
    return{snapshot,eligible:row.eligible,source:{...snapshot,transaction:{...snapshot.transaction,occurredAt:new Date(snapshot.transaction.occurredAt)}}};
  }
  party(kind:z.infer<typeof receivablePartyKind>,partyId:string){
    const where={organizationId:this.organizationId,id:partyId},select={id:true,organizationId:true};
    switch(kind){case"GUEST":return this.tx.guestRecord.findFirst({where,select});case"OWNER":return this.tx.owner.findFirst({where,select});case"SUPPLIER":return this.tx.supplier.findFirst({where,select});case"PERSON":return this.tx.person.findFirst({where,select});}
  }
  parties(kind:z.infer<typeof receivablePartyKind>,search:string,after?:string){
    const where={organizationId:this.organizationId,...after?{id:{gt:after}}:{},...search?{displayName:{contains:search,mode:"insensitive" as const}}:{}},select={id:true,displayName:true},orderBy={id:"asc" as const};
    switch(kind){case"GUEST":return this.tx.guestRecord.findMany({where,select,orderBy,take:26});case"OWNER":return this.tx.owner.findMany({where,select,orderBy,take:26});case"SUPPLIER":return this.tx.supplier.findMany({where,select,orderBy,take:26});case"PERSON":return this.tx.person.findMany({where,select,orderBy,take:26});}
  }
  sources(accountCodes:readonly string[],currency:string,after?:string){return this.tx.$queryRaw<Array<{id:string;reference:string;occurredAt:Date;original:string;unassigned:string}>>(Prisma.sql`
    WITH selected AS MATERIALIZED(
      SELECT p.id,p.amount,t.reference,t.occurred_at FROM posting p
      JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
      JOIN ledger_account k ON k.organization_id=p.organization_id AND k.id=p.ledger_account_id
      WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${currency} AND p.side='DEBIT'
        AND k.account_type='CLAIM_OWNERSHIP' AND k.normal_side='DEBIT' AND k.code IN(${Prisma.join([...accountCodes])})
        AND t.sealed AND t.reverses_transaction_id IS NULL AND t.occurred_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=t.organization_id AND r.reverses_transaction_id=t.id)
        ${after?Prisma.sql`AND p.id>${after}::uuid`:Prisma.empty}
      ORDER BY p.id LIMIT 26)
    SELECT s.id::text,s.reference,s.occurred_at AS "occurredAt",s.amount::text AS original,
      (s.amount-COALESCE((SELECT sum(a.amount) FROM receivable_assignment a WHERE a.organization_id=${this.organizationId}::uuid AND a.posting_id=s.id
        AND NOT EXISTS(SELECT 1 FROM receivable_assignment_release r WHERE r.organization_id=a.organization_id AND r.assignment_id=a.id)),0))::text AS unassigned
    FROM selected s ORDER BY s.id`);}
  history(after?:string,search?:string){return this.tx.receivableAssignment.findMany({where:{organizationId:this.organizationId,...after?{id:{gt:after}}:{},...search?{purpose:{contains:search,mode:"insensitive" as const}}:{}},orderBy:{id:"asc"},take:26,include:{release:true}});}
  activeAssignments(postingId:string,exceptId?:string){return this.tx.receivableAssignment.findMany({where:{organizationId:this.organizationId,postingId,release:{is:null},...(exceptId?{id:{not:exceptId}}:{})},orderBy:{id:"asc"},select:{id:true,amount:true,currency:true}});}
  byKey(idempotencyKey:string){return this.tx.receivableAssignment.findFirst({where:{organizationId:this.organizationId,idempotencyKey},include:{release:true}});}
  get(id:string){return this.tx.receivableAssignment.findFirst({where:{organizationId:this.organizationId,id},include:{release:true}});}
  releaseByKey(idempotencyKey:string){return this.tx.receivableAssignmentRelease.findFirst({where:{organizationId:this.organizationId,idempotencyKey},include:{assignment:{include:{release:true}}}});}
  create(data:Omit<Prisma.ReceivableAssignmentUncheckedCreateInput,"organizationId"|"collections"|"release">){return this.tx.receivableAssignment.create({data:{...data,organizationId:this.organizationId},include:{release:true}});}
  release(data:Omit<Prisma.ReceivableAssignmentReleaseUncheckedCreateInput,"organizationId">){return this.tx.receivableAssignmentRelease.create({data:{...data,organizationId:this.organizationId}});}
  async flushGuards(){await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");await this.tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");}
}
