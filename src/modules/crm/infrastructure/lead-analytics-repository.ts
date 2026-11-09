import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import {leadStages} from "../domain/lead-pipeline";
import type {LeadAnalyticsInput,LeadAnalyticsRow} from "../domain/lead-analytics";

/** Read existing native history only. No contact ciphertext, Owner identity or financial rows enter this projection. */
export class LeadAnalyticsRepository{
 constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
 rows(input:LeadAnalyticsInput,observedAt:Date,maxSourceGroups:number){
  return this.tx.$queryRaw<LeadAnalyticsRow[]>(Prisma.sql`
   SELECT l.source_key AS "sourceKey",l.channel,
    (SELECT source->'label' FROM jsonb_array_elements(l.policy_snapshot->'value'->'sources') source WHERE source->>'key'=l.source_key) AS "sourceLabel",
    coalesce(s.to_stage,l.initial_stage) AS stage,count(*)::text AS captured,count(c.id)::text AS converted
   FROM lead l
   LEFT JOIN LATERAL(SELECT to_stage FROM lead_stage_revision WHERE organization_id=l.organization_id AND lead_id=l.id AND created_at<=${observedAt} ORDER BY number DESC LIMIT 1)s ON true
   LEFT JOIN lead_conversion c ON c.organization_id=l.organization_id AND c.lead_id=l.id AND c.created_at<=${observedAt}
   WHERE l.organization_id=${this.organizationId}::uuid AND l.created_at>=${input.from}::timestamptz AND l.created_at<${input.until}::timestamptz AND l.created_at<=${observedAt}
    ${input.sourceKey?Prisma.sql`AND l.source_key=${input.sourceKey}`:Prisma.empty}
   GROUP BY l.source_key,l.channel,"sourceLabel",coalesce(s.to_stage,l.initial_stage)
   ORDER BY l.source_key,l.channel,"sourceLabel",stage
   LIMIT ${maxSourceGroups*leadStages.length+1}`);
 }
}
