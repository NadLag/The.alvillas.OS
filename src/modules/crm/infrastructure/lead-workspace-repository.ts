import {Prisma} from "@prisma/client";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {LeadWorkspaceInput} from "../domain/lead-workspace";
export type LeadWorkspaceCandidate={id:string;createdAtKey:string;profileRevisionId:string|null;stageRevisionId:string|null;stage:string;sourceKey:string};
export class LeadWorkspaceRepository{
  constructor(private readonly tx:TenantTransaction,private readonly organizationId:string){}
  candidates(input:LeadWorkspaceInput,asOf:Date,before?:{id:string;createdAt:string}){
    return this.tx.$queryRaw<LeadWorkspaceCandidate[]>(Prisma.sql`SELECT l.id,to_char(l.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAtKey",p.id AS "profileRevisionId",s.id AS "stageRevisionId",coalesce(s.to_stage,l.initial_stage) AS stage,coalesce(p.source_key,l.source_key) AS "sourceKey"
      FROM lead l LEFT JOIN LATERAL(SELECT id,to_stage FROM lead_stage_revision WHERE organization_id=l.organization_id AND lead_id=l.id ORDER BY number DESC LIMIT 1)s ON true
      LEFT JOIN LATERAL(SELECT id,source_key FROM lead_profile_revision WHERE organization_id=l.organization_id AND lead_id=l.id ORDER BY number DESC LIMIT 1)p ON true
      WHERE l.organization_id=${this.organizationId}::uuid AND l.created_at<=${asOf}
      ${input.leadId?Prisma.sql`AND l.id=${input.leadId}::uuid`:Prisma.empty}
      ${before?Prisma.sql`AND(l.created_at,l.id)<(${before.createdAt}::timestamptz,${before.id}::uuid)`:Prisma.empty}
      ${input.stage?Prisma.sql`AND coalesce(s.to_stage,l.initial_stage)=${input.stage}`:Prisma.empty}
      ${input.sourceKey?Prisma.sql`AND coalesce(p.source_key,l.source_key)=${input.sourceKey}`:Prisma.empty}
      ORDER BY l.created_at DESC,l.id DESC LIMIT 101`);
  }
  rows(ids:readonly string[]){return this.tx.lead.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]}},include:{stageRevisions:{orderBy:{number:"desc"},take:1},profileRevisions:{orderBy:{number:"desc"},take:1}}});}
}
