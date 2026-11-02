import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {ReceivableAgingPolicy} from "../domain/receivable-aging";
import type {receivablePartyKind} from "../domain/receivable-assignment";
import type {z} from "zod";

export type ReceivableAgingPosition={id:string;postingId:string;partyKind:z.infer<typeof receivablePartyKind>;partyId:string;purpose:string;dueOn:string|null;daysPastDue:number|null;bucket:string;assigned:string;collected:string;outstanding:string};
export type ReceivableAgingSnapshot={at:Date;on:string;fingerprint:string;valid:boolean;groups:Array<{key:string;outstanding:string;count:string}>;items:ReceivableAgingPosition[]};
type Input={currency:string;timezone:string;policy:ReceivableAgingPolicy;accountCodes:readonly string[];bucket?:string;partyKind?:z.infer<typeof receivablePartyKind>;partyId?:string;search:string;after?:{id:string;dueOn:string|null}};

/** One MVCC statement derives bounded output from the shared original/opposite movement calculation. */
export class ReceivableAgingRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 async snapshot(input:Input){
  const bands=JSON.stringify(input.policy.bands.map(({key,from_days,through_days})=>({key,from_days,through_days}))),after=input.after;
  const[report]=await this.tx.$queryRaw<ReceivableAgingSnapshot[]>(Prisma.sql`
   WITH clock AS MATERIALIZED(SELECT clock_timestamp() at),period AS MATERIALIZED(
    SELECT at,(at AT TIME ZONE ${input.timezone})::date AS on FROM clock
   ),selected AS MATERIALIZED(
    SELECT a.id,a.posting_id,a.party_kind,COALESCE(a.guest_id,a.owner_id,a.supplier_id,a.person_id) AS party_id,a.purpose,a.due_on,a.amount
    FROM receivable_assignment a
    JOIN posting p ON p.organization_id=a.organization_id AND p.id=a.posting_id
    JOIN financial_transaction t ON t.organization_id=p.organization_id AND t.id=p.transaction_id
    JOIN ledger_account k ON k.organization_id=p.organization_id AND k.id=p.ledger_account_id
    WHERE a.organization_id=${this.organizationId}::uuid AND a.currency=${input.currency} AND p.currency=${input.currency}
     AND p.side='DEBIT' AND k.account_type='CLAIM_OWNERSHIP' AND k.normal_side='DEBIT' AND k.code IN(${Prisma.join([...input.accountCodes])})
     AND t.sealed AND t.reverses_transaction_id IS NULL AND t.occurred_at<=(SELECT at FROM period)
     AND NOT EXISTS(SELECT 1 FROM financial_transaction r WHERE r.organization_id=t.organization_id AND r.reverses_transaction_id=t.id)
     AND NOT EXISTS(SELECT 1 FROM receivable_assignment_release r WHERE r.organization_id=a.organization_id AND r.assignment_id=a.id)
     ${input.partyKind?Prisma.sql`AND a.party_kind=${input.partyKind}`:Prisma.empty}
     ${input.partyId?Prisma.sql`AND COALESCE(a.guest_id,a.owner_id,a.supplier_id,a.person_id)=${input.partyId}::uuid`:Prisma.empty}
     ${input.search?Prisma.sql`AND position(lower(${input.search}) in lower(a.purpose))>0`:Prisma.empty}
   ),movements AS MATERIALIZED(
    SELECT * FROM app_receivable_collection_movements_for(${this.organizationId}::uuid,
     COALESCE((SELECT array_agg(id) FROM selected),ARRAY[]::uuid[]),${input.currency})
   ),facts AS MATERIALIZED(
    SELECT a.*,m.collected,m.fingerprint,a.amount-m.collected AS outstanding,
     CASE WHEN a.due_on IS NULL THEN NULL ELSE period.on-a.due_on END AS days_past_due,
     CASE WHEN a.due_on IS NULL THEN 'UNSCHEDULED' WHEN a.due_on>=period.on THEN 'NOT_DUE' ELSE band.key END AS bucket
    FROM selected a JOIN movements m ON m.assignment_id=a.id CROSS JOIN period
    LEFT JOIN LATERAL(SELECT b.key FROM jsonb_to_recordset(${bands}::jsonb) AS b(key text,from_days numeric,through_days numeric)
     WHERE period.on-a.due_on>=b.from_days AND(b.through_days IS NULL OR period.on-a.due_on<=b.through_days)
     ORDER BY b.from_days LIMIT 1) band ON true
   ),open AS MATERIALIZED(SELECT * FROM facts WHERE outstanding>0 ${input.bucket?Prisma.sql`AND bucket=${input.bucket}`:Prisma.empty}),grouped AS(
    SELECT bucket AS key,sum(outstanding)::text AS outstanding,count(*)::text AS count FROM open GROUP BY bucket
   ),page AS MATERIALIZED(
    SELECT * FROM open a WHERE true
     ${input.bucket?Prisma.sql`AND a.bucket=${input.bucket}`:Prisma.empty}
     ${after?after.dueOn===null?Prisma.sql`AND a.due_on IS NULL AND a.id>${after.id}::uuid`:Prisma.sql`AND(a.due_on>${after.dueOn}::date OR a.due_on IS NULL OR a.due_on=${after.dueOn}::date AND a.id>${after.id}::uuid)`:Prisma.empty}
    ORDER BY due_on ASC NULLS LAST,id ASC LIMIT 51
   )
   SELECT period.at,period.on::text AS on,
    NOT EXISTS(SELECT 1 FROM facts WHERE amount<=0 OR collected<0 OR collected>amount OR bucket IS NULL)
     AND(SELECT count(*) FROM selected)=(SELECT count(*) FROM movements) AS valid,
    encode(sha256(convert_to(period.on::text||':'||COALESCE((SELECT string_agg(id::text||':'||amount::text||':'||COALESCE(due_on::text,'')||':'||fingerprint,',' ORDER BY id) FROM facts),''),'UTF8')),'hex') AS fingerprint,
    COALESCE((SELECT jsonb_agg(to_jsonb(grouped) ORDER BY key) FROM grouped),'[]'::jsonb) AS groups,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'postingId',posting_id,'partyKind',party_kind,'partyId',party_id,'purpose',purpose,
     'dueOn',due_on::text,'daysPastDue',days_past_due,'bucket',bucket,'assigned',amount::text,'collected',(collected+0.00)::text,'outstanding',outstanding::text)
     ORDER BY due_on ASC NULLS LAST,id ASC) FROM page),'[]'::jsonb) AS items
   FROM period`);
  if(!report)throw Error("Original receivable aging snapshot is unavailable");return report;
 }
}
