import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { DocumentRepository } from "./document-repository";
import { literalDocumentSearchPattern, type documentSearchInputSchema } from "../domain/document-search";
import type { documentSourceKinds } from "../domain/document-policy";

type SourceKind=typeof documentSourceKinds[number];
type Input=z.infer<typeof documentSearchInputSchema>;
export class DocumentSearchRepository extends DocumentRepository {
  async searchCandidates(input:Input,sourceKinds:readonly SourceKind[],financialDenied:readonly SourceKind[],asOf:Date,before?:string):Promise<Array<{id:string}>>{
    if(!sourceKinds.length)return[];const pattern=literalDocumentSearchPattern(input.query);
    return this.tx.$queryRaw<Array<{id:string}>>(Prisma.sql`SELECT v.id FROM document_version v
      JOIN document d ON d.organization_id=v.organization_id AND d.id=v.document_id
      JOIN document_admission a ON a.organization_id=v.organization_id AND a.id=v.admission_id
      WHERE v.organization_id=${this.organizationId}::uuid AND d.organization_id=${this.organizationId}::uuid
      AND d.source_kind IN(${Prisma.join(sourceKinds)}) AND v.created_at<=${asOf}
      AND (v.title ILIKE ${pattern} ESCAPE E'\\\\' OR a.file_name ILIKE ${pattern} ESCAPE E'\\\\')
      ${before?Prisma.sql`AND v.id<${before}::uuid`:Prisma.empty}
      ${input.kind!=="ALL"?Prisma.sql`AND d.kind=${input.kind}`:Prisma.empty}
      ${input.locale?Prisma.sql`AND d.locale=${input.locale}`:Prisma.empty}
      ${input.sourceKind?Prisma.sql`AND d.source_kind=${input.sourceKind}`:Prisma.empty}
      ${input.source?Prisma.sql`AND d.source_kind=${input.source.kind} AND d.source_id=${input.source.id}::uuid`:Prisma.empty}
      ${!input.includeArchived?Prisma.sql`AND d.archived_at IS NULL`:Prisma.empty}
      ${financialDenied.length?Prisma.sql`AND NOT('financial'=ANY(d.privacy) AND d.source_kind IN(${Prisma.join(financialDenied)}))`:Prisma.empty}
      ${input.category?Prisma.sql`AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(d.policy_snapshot#>'{value,types}','[]'::jsonb)) t WHERE t->>'key'=d.type_key AND t->>'category'=${input.category})`:Prisma.empty}
      ${input.versionSelection==="CURRENT_EFFECTIVE"?Prisma.sql`AND v.id=(SELECT e.id FROM document_version e WHERE e.organization_id=${this.organizationId}::uuid AND e.document_id=d.id AND e.created_at<=${asOf} AND(e.effective_from IS NULL OR e.effective_from<=${asOf}) ORDER BY e.number DESC LIMIT 1)`:Prisma.empty}
      ORDER BY v.id DESC LIMIT 101`);
  }
}
