import {Prisma} from "@prisma/client";
import type {TenantTransaction,TenantTransactionRunner} from "@/platform/db/tenant";
import {LedgerCalendarRepository} from "./ledger-calendar-repository";
import type {PropertyFinanceAccountFacts} from "../domain/property-finance";

export type PropertyFinancePosting={id:string;transactionId:string;reference:string;occurredAt:string;description:string|null;side:"DEBIT"|"CREDIT";amount:string;currency:string;bucket:string|null;accountId:string;accountName:string;accountType:string;normalSide:"DEBIT"|"CREDIT";reversesTransactionId:string|null;expenseId:string|null;invoiceId:string|null;employeeSubmissionId:string|null;employeeClaimId:string|null};
export type PropertyFinanceSnapshot={fingerprint:string;cursorFound:boolean;accounts:PropertyFinanceAccountFacts[];items:PropertyFinancePosting[]};
/** Financial positions and their original history page share one MVCC statement. */
export class PropertyFinanceRepository extends LedgerCalendarRepository{
 constructor(readonly tx:TenantTransaction,readonly organizationId:string){super(tx,organizationId);}
 runner():TenantTransactionRunner{return{$transaction:async work=>work(this.tx)};}
 property(id:string){return this.tx.property.findFirst({where:{organizationId:this.organizationId,id},select:{id:true,name:true,cityId:true,regionId:true,timezone:true,archivedAt:true}});}
 currencies(){return this.tx.currency.findMany({orderBy:{code:"asc"},select:{code:true,minorUnit:true}});}
 async snapshot(input:{propertyId:string;currency:string;startsAt:Date;endsAt:Date;after?:string}){
  const[report]=await this.tx.$queryRaw<PropertyFinanceSnapshot[]>(Prisma.sql`
   WITH original AS MATERIALIZED(
    SELECT p.id,p.transaction_id,t.reference,t.occurred_at,t.description,t.reverses_transaction_id,p.side,p.amount,p.currency,p.bucket,
     a.id AS account_id,a.name AS account_name,a.account_type,a.normal_side
    FROM posting p JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
    JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id
    WHERE p.organization_id=${this.organizationId}::uuid AND p.currency=${input.currency}
     AND p.dimensions->>'property_id'=${input.propertyId} AND t.sealed AND t.occurred_at<${input.endsAt}
   ),positions AS(
    SELECT account_id AS id,account_name AS name,account_type AS "accountType",normal_side AS "normalSide",currency,
     COALESCE(sum(amount) FILTER(WHERE occurred_at<${input.startsAt} AND side='DEBIT'),0)::text AS "openingDebits",
     COALESCE(sum(amount) FILTER(WHERE occurred_at<${input.startsAt} AND side='CREDIT'),0)::text AS "openingCredits",
     COALESCE(sum(amount) FILTER(WHERE occurred_at>=${input.startsAt} AND side='DEBIT'),0)::text AS "periodDebits",
     COALESCE(sum(amount) FILTER(WHERE occurred_at>=${input.startsAt} AND side='CREDIT'),0)::text AS "periodCredits",count(*)::text AS "postingCount"
    FROM original GROUP BY account_id,account_name,account_type,normal_side,currency
   ),period AS MATERIALIZED(SELECT * FROM original WHERE occurred_at>=${input.startsAt}),boundary AS(
    SELECT id,occurred_at FROM period WHERE ${input.after?Prisma.sql`id=${input.after}::uuid`:Prisma.sql`false`}
   ),selected_page AS MATERIALIZED(
    SELECT * FROM period ${input.after?Prisma.sql`WHERE(occurred_at,id)<(SELECT occurred_at,id FROM boundary)`:Prisma.empty}
    ORDER BY occurred_at DESC,id DESC LIMIT 51
   ),page AS(
    SELECT p.id,p.transaction_id AS "transactionId",p.reference,to_char(p.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "occurredAt",
     p.description,p.side,p.amount::text,p.currency,p.bucket,p.account_id AS "accountId",p.account_name AS "accountName",p.account_type AS "accountType",p.normal_side AS "normalSide",p.reverses_transaction_id AS "reversesTransactionId",
     e.id AS "expenseId",r.invoice_id AS "invoiceId",claim.submission_id AS "employeeSubmissionId",claim.claim_id AS "employeeClaimId"
    FROM selected_page p
    LEFT JOIN expense e ON e.organization_id=${this.organizationId}::uuid AND e.transaction_id=COALESCE(p.reverses_transaction_id,p.transaction_id)
    LEFT JOIN supplier_invoice_recognition_line ir ON ir.organization_id=${this.organizationId}::uuid AND ir.transaction_id=COALESCE(p.reverses_transaction_id,p.transaction_id)
    LEFT JOIN supplier_invoice_line il ON il.organization_id=ir.organization_id AND il.id=ir.invoice_line_id
    LEFT JOIN supplier_invoice_revision r ON r.organization_id=il.organization_id AND r.id=il.revision_id
    LEFT JOIN employee_compensation_recognition_line salary ON salary.organization_id=${this.organizationId}::uuid AND salary.transaction_id=COALESCE(p.reverses_transaction_id,p.transaction_id)
    LEFT JOIN employee_compensation_recognition claim ON claim.organization_id=salary.organization_id AND claim.id=salary.recognition_id
   ),identity AS(
    SELECT md5(COALESCE(string_agg(md5(row_to_json(o)::text),'' ORDER BY id),'')) AS fingerprint FROM original o
   )
   SELECT(SELECT fingerprint FROM identity) AS fingerprint,${input.after?Prisma.sql`EXISTS(SELECT 1 FROM boundary)`:Prisma.sql`true`} AS "cursorFound",
    COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a."accountType",a.name,a.id) FROM positions a),'[]'::jsonb) AS accounts,
    COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."occurredAt" DESC,p.id DESC) FROM page p),'[]'::jsonb) AS items`);
  return report;
 }
}
