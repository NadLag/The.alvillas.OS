import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";

/** Canonical financial sources and their full original journals are loaded once per actual identity. */
export class EmployeePercentageSourceRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 candidates(input:{startsAt:Date;endsAt:Date;currency:string;buckets:readonly string[];side:"DEBIT"|"CREDIT";after?:{at:string;postingId:string;assignmentId:string}}){
  return this.tx.$queryRaw<Array<{postingId:string;assignmentId:string;at:string}>>(Prisma.sql`
   SELECT p.id AS "postingId",a.id AS "assignmentId",to_char(t.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
   FROM posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
   JOIN ledger_account ledger ON ledger.organization_id=p.organization_id AND ledger.id=p.ledger_account_id AND ledger.account_type='ALVILLAS_OWN' AND ledger.archived_at IS NULL
   LEFT JOIN operation_task original_task ON original_task.organization_id=p.organization_id AND original_task.id::text=lower(COALESCE(p.dimensions->>'task_id',p.dimensions->>'job_id'))
   LEFT JOIN reservation original_reservation ON original_reservation.organization_id=p.organization_id AND original_reservation.id::text=lower(COALESCE(p.dimensions->>'reservation_id',original_task.reservation_id::text))
   LEFT JOIN property original_property ON original_property.organization_id=p.organization_id AND original_property.id::text=lower(COALESCE(p.dimensions->>'property_id',original_reservation.property_id::text,original_task.property_id::text))
   JOIN role_assignment a ON a.organization_id=p.organization_id AND a.valid_from<=t.occurred_at AND(a.valid_to IS NULL OR a.valid_to>t.occurred_at) AND(a.archived_at IS NULL OR a.archived_at>t.occurred_at)
   JOIN LATERAL(SELECT c.mode,c.currency FROM team_compensation c WHERE c.organization_id=a.organization_id AND c.assignment_id=a.id AND c.effective_from<=t.occurred_at ORDER BY c.version DESC LIMIT 1) contract ON contract.mode='PERCENTAGE' AND contract.currency=p.currency
   WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency} AND p.bucket=ANY(${[...input.buckets]}::text[]) AND p.side=${input.side}
   AND t.sealed AND t.reverses_transaction_id IS NULL AND t.occurred_at>=${input.startsAt} AND t.occurred_at<${input.endsAt} AND t.occurred_at<=clock_timestamp()
   AND(a.scope_type='organization' OR a.scope_type='property' AND a.scope_id=original_property.id OR a.scope_type='job' AND a.scope_id=original_task.id OR a.scope_type='city' AND a.scope_id=original_property.city_id OR a.scope_type='region' AND a.scope_id=original_property.region_id)
   AND NOT EXISTS(SELECT 1 FROM financial_transaction reversal WHERE reversal.organization_id=t.organization_id AND reversal.reverses_transaction_id=t.id)
   ${input.after?Prisma.sql`AND(t.occurred_at,p.id,a.id)<(${input.after.at}::timestamptz,${input.after.postingId}::uuid,${input.after.assignmentId}::uuid)`:Prisma.empty}
   ORDER BY t.occurred_at DESC,p.id DESC,a.id DESC LIMIT 26`);
 }
 async bases(ids:readonly string[]){
  const postings=await this.tx.posting.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},orderBy:{id:"asc"},select:{id:true,organizationId:true,transactionId:true,ledgerAccountId:true,side:true,amount:true,currency:true,bucket:true,dimensions:true,createdAt:true}});
  const transactionIds=[...new Set(postings.map(row=>row.transactionId))],accountIds=[...new Set(postings.map(row=>row.ledgerAccountId))];
  const[transactions,accounts]=await Promise.all([
   transactionIds.length?this.tx.financialTransaction.findMany({where:{organizationId:this.organizationId,id:{in:transactionIds}},orderBy:{id:"asc"},select:{id:true,organizationId:true,reference:true,occurredAt:true,createdAt:true,createdBy:true,sealed:true,reversesTransactionId:true,reversedByTransactions:{where:{organizationId:this.organizationId},orderBy:{id:"asc"},select:{id:true}},postings:{where:{organizationId:this.organizationId},orderBy:{id:"asc"},select:{id:true,ledgerAccountId:true,side:true,amount:true,currency:true,bucket:true,dimensions:true}}}}):[],
   accountIds.length?this.tx.ledgerAccount.findMany({where:{organizationId:this.organizationId,id:{in:accountIds}},select:{id:true,organizationId:true,code:true,accountType:true,normalSide:true,archivedAt:true}}):[]
  ]);
  const byTransaction=new Map(transactions.map(row=>[row.id,row])),byAccount=new Map(accounts.map(row=>[row.id,row]));
  return postings.map(posting=>({posting,transaction:byTransaction.get(posting.transactionId)??null,account:byAccount.get(posting.ledgerAccountId)??null}));
 }
 properties(ids:readonly string[]){return this.tx.property.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,cityId:true,regionId:true}});}
 reservations(ids:readonly string[]){return this.tx.reservation.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,propertyId:true}});}
 tasks(ids:readonly string[]){return this.tx.operationTask.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true,propertyId:true,reservationId:true}});}
 owners(ids:readonly string[]){return this.tx.owner.findMany({where:{organizationId:this.organizationId,id:{in:[...new Set(ids)]}},select:{id:true}});}
 async lockJournals(ids:readonly string[]){
  const ordered=[...new Set(ids)].sort();if(!ordered.length)return;
  await this.tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${this.organizationId+":journal-reversal:"}||source.id,0))::text
   FROM unnest(${ordered}::text[]) AS source(id) ORDER BY source.id`);
 }
 /** SQL checks the actual instant before any JavaScript timestamp conversion can select a future boundary. */
 async preciseContracts(entries:readonly {postingId:string;assignmentId:string;compensationId:string;configRuleId:string}[]){
  if(!entries.length)return[];
  return this.tx.$queryRaw<Array<{postingId:string;assignmentId:string}>>(Prisma.sql`
   WITH requested AS(SELECT * FROM jsonb_to_recordset(${JSON.stringify(entries.map(({postingId,assignmentId,compensationId,configRuleId})=>({postingId,assignmentId,compensationId,configRuleId})))}::jsonb) AS x("postingId" uuid,"assignmentId" uuid,"compensationId" uuid,"configRuleId" uuid)),
   selected_postings AS MATERIALIZED(
    SELECT x.*,p.organization_id,p.transaction_id FROM requested x
    JOIN posting p ON p.id=x."postingId" AND p.organization_id=${this.organizationId}::uuid
   ),originals AS MATERIALIZED(
    SELECT p.*,t.occurred_at FROM selected_postings p
    JOIN financial_transaction t ON t.id=p.transaction_id AND t.organization_id=p.organization_id
   )
   SELECT x."postingId" AS "postingId",a.id AS "assignmentId" FROM originals x
   JOIN role_assignment a ON a.id=x."assignmentId" AND a.organization_id=x.organization_id
   JOIN team_compensation c ON c.id=x."compensationId" AND c.organization_id=x.organization_id AND c.assignment_id=a.id
   JOIN config_rule r ON r.id=x."configRuleId" AND r.organization_id=x.organization_id AND r.id=c.config_rule_id
   WHERE date_trunc('milliseconds',x.occurred_at)=x.occurred_at
   AND a.valid_from<=x.occurred_at AND (a.valid_to IS NULL OR a.valid_to>x.occurred_at) AND (a.archived_at IS NULL OR a.archived_at>x.occurred_at)
   AND c.effective_from<=x.occurred_at AND r.effective_from<=x.occurred_at AND (r.effective_to IS NULL OR r.effective_to>x.occurred_at)
   AND NOT EXISTS(SELECT 1 FROM team_compensation newer WHERE newer.organization_id=c.organization_id AND newer.assignment_id=a.id AND newer.effective_from<=x.occurred_at AND newer.version>c.version)
   ORDER BY x."postingId",a.id`);
 }
}
