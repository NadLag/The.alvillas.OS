import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

/** Canonical financial sources and their full original journals are loaded once per actual identity. */
export class EmployeePercentageSourceRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async bases(ids:readonly string[]){
  const postings=await this.tx.posting.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},orderBy:{id:"asc"},select:{id:true,organizationId:true,transactionId:true,ledgerAccountId:true,side:true,amount:true,currency:true,bucket:true,dimensions:true,createdAt:true}});
  const transactionIds=[...new Set(postings.map(row=>row.transactionId))],accountIds=[...new Set(postings.map(row=>row.ledgerAccountId))];
  const[transactions,accounts]=await Promise.all([
   transactionIds.length?this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,id:{in:transactionIds}},orderBy:{id:"asc"},select:{id:true,organizationId:true,occurredAt:true,createdAt:true,createdBy:true,sealed:true,reversesTransactionId:true,reversedByTransactions:{where:{organizationId:this.organizationId},orderBy:{id:"asc"},select:{id:true}},postings:{where:{organizationId:this.organizationId},orderBy:{id:"asc"},select:{id:true,side:true,amount:true,currency:true,dimensions:true}}}}):[],
   accountIds.length?this.tx.ledgerAccount.findMany({where:{organizationId:this.organizationId,id:{in:accountIds}},select:{id:true,organizationId:true,code:true,accountType:true,normalSide:true,archivedAt:true}}):[]
  ]);
  const byTransaction=new Map(transactions.map(row=>[row.id,row])),byAccount=new Map(accounts.map(row=>[row.id,row]));
  return postings.map(posting=>({posting,transaction:byTransaction.get(posting.transactionId)??null,account:byAccount.get(posting.ledgerAccountId)??null}));
 }
 properties(ids:readonly string[]){return this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,cityId:true,regionId:true}});}
 reservations(ids:readonly string[]){return this.tx.reservation.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,propertyId:true}});}
 tasks(ids:readonly string[]){return this.tx.operationTask.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,propertyId:true,reservationId:true}});}
 owners(ids:readonly string[]){return this.tx.owner.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true}});}
 /** SQL checks the actual instant before any JavaScript timestamp conversion can select a future boundary. */
 async preciseContracts(entries:readonly {postingId:string;assignmentId:string;compensationId:string;configRuleId:string}[]){
  if(!entries.length)return[];
  return this.tx.$queryRaw<Array<{postingId:string;assignmentId:string}>>(Prisma.sql`
   WITH requested AS(SELECT * FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb) AS x("postingId" uuid,"assignmentId" uuid,"compensationId" uuid,"configRuleId" uuid))
   SELECT p.id AS "postingId",a.id AS "assignmentId" FROM requested x
   JOIN posting p ON p.id=x."postingId" AND p.organization_id=${this.organizationId}::uuid
   JOIN financial_transaction t ON t.id=p.transaction_id AND t.organization_id=p.organization_id
   JOIN role_assignment a ON a.id=x."assignmentId" AND a.organization_id=p.organization_id
   JOIN team_compensation c ON c.id=x."compensationId" AND c.organization_id=p.organization_id AND c.assignment_id=a.id
   JOIN config_rule r ON r.id=x."configRuleId" AND r.organization_id=p.organization_id AND r.id=c.config_rule_id
   WHERE date_trunc('milliseconds',t.occurred_at)=t.occurred_at
   AND a.valid_from<=t.occurred_at AND (a.valid_to IS NULL OR a.valid_to>t.occurred_at) AND (a.archived_at IS NULL OR a.archived_at>t.occurred_at)
   AND c.effective_from<=t.occurred_at AND r.effective_from<=t.occurred_at AND (r.effective_to IS NULL OR r.effective_to>t.occurred_at)
   AND NOT EXISTS(SELECT 1 FROM team_compensation newer WHERE newer.organization_id=c.organization_id AND newer.assignment_id=a.id AND newer.effective_from<=t.occurred_at AND newer.version>c.version)
   ORDER BY p.id,a.id`);
 }
}
