import { Prisma } from "@prisma/client";
import type { z } from "zod";
import { DocumentRepository } from "./document-repository";
import { literalDocumentSearchPattern, type documentSearchInputSchema } from "../domain/document-search";
import type { documentSourceKinds } from "../domain/document-policy";
import { generatedDocumentUploadInput } from "../domain/document-generated-upload";

type SourceKind=typeof documentSourceKinds[number];
type Input=z.infer<typeof documentSearchInputSchema>;
const metadataSelect={id:true,organizationId:true,documentId:true,number:true,title:true,supersedesId:true,effectiveFrom:true,createdAt:true,createdBy:true,next:{select:{id:true}},admission:{select:{fileName:true,contentType:true,fileSize:true,sha256:true,reason:true,input:true}}} satisfies Prisma.DocumentVersionSelect;
type Metadata=Prisma.DocumentVersionGetPayload<{select:typeof metadataSelect}>;
type Root=NonNullable<Awaited<ReturnType<DocumentRepository["document"]>>>;
type Effective={id:string;documentId:string;number:number;effectiveFrom:Date|null;createdAt:Date};
export class DocumentSearchRepository extends DocumentRepository {
  private metadataRows=new Map<string,Metadata>();
  private preparedIds=new Set<string>();
  private rootReads=new Map<string,Root>();
  private effectiveRows=new Map<string,Effective>();
  private effectiveAt:number|null=null;
  private artifactDocuments=new Set<string>();
  private preparedDocuments=new Set<string>();
  preparedRoots(){return[...new Map([...this.rootReads.values()].map(root=>[root.id,root])).values()];}
  knownAbsentSignedArtifact(documentId:string){return this.preparedDocuments.has(documentId)&&!this.artifactDocuments.has(documentId);}
  /** Read only metadata. Large encrypted PDF/template payloads never enter a search page. */
  async metadataVersion(id:string):Promise<Metadata|null>{
    if(this.preparedIds.has(id))return this.metadataRows.get(id)??null;
    return this.tx.documentVersion.findFirst({where:{organizationId:this.organizationId,id},select:metadataSelect});
  }
  async searchDocument(id:string,instanceId?:string):Promise<Root|null>{
    const cached=this.rootReads.get(id+":"+(instanceId??""));return cached??this.document(id,instanceId);
  }
  async prepareMetadata(ids:readonly string[],asOf:Date){
    if(ids.length>100)throw Error("Bounded document read batch required");
    const rows=await this.tx.documentVersion.findMany({where:{organizationId:this.organizationId,id:{in:[...ids]}},select:metadataSelect});
    this.preparedIds=new Set(ids);this.metadataRows=new Map(rows.map(row=>[row.id,row]));this.rootReads.clear();
    const references=rows.map(row=>{const parsed=generatedDocumentUploadInput.safeParse(row.admission.input);return{documentId:row.documentId,instanceId:parsed.success?parsed.data.generationInstanceId:undefined};}),instanceIds=[...new Set(references.flatMap(r=>r.instanceId?[r.instanceId]:[]))],documentIds=[...new Set(references.map(r=>r.documentId))];
    const documents=await this.tx.document.findMany({where:{organizationId:this.organizationId,id:{in:documentIds}},include:{template:true,instances:{where:{id:{in:instanceIds}},orderBy:{createdAt:"desc"}}}});
    this.preparedDocuments=new Set(documentIds);const artifacts=documentIds.length?await this.tx.signatureSignedArtifact.findMany({where:{organizationId:this.organizationId,documentId:{in:documentIds}},select:{documentId:true}}):[];this.artifactDocuments=new Set(artifacts.map(row=>row.documentId));
    for(const row of documents){const{instances,...root}=row;
      if(root.kind!=="INSTANCE")this.rootReads.set(root.id+":",{...root,instance:null});
      for(const reference of references.filter(r=>r.documentId===row.id&&r.instanceId)){const instance=instances.find(i=>i.id===reference.instanceId);if(instance)this.rootReads.set(root.id+":"+reference.instanceId,{...root,instance});}
    }
    this.effectiveRows=await this.effectiveVersions(documentIds,asOf);this.effectiveAt=asOf.getTime();
  }
  async effectiveMetadata(documentId:string,asOf:Date){
    if(this.effectiveAt===asOf.getTime())return this.effectiveRows.get(documentId)??null;
    return this.effectiveVersion(documentId,asOf);
  }
  async effectiveVersions(documentIds:readonly string[],asOf:Date):Promise<Map<string,Effective>>{
    if(!documentIds.length)return new Map();const rows=await this.tx.$queryRaw<Effective[]>(Prisma.sql`SELECT DISTINCT ON(document_id) id,document_id AS "documentId",number,effective_from AS "effectiveFrom",created_at AS "createdAt" FROM document_version WHERE organization_id=${this.organizationId}::uuid AND document_id IN(${Prisma.join(documentIds.map(id=>Prisma.sql`${id}::uuid`))}) AND created_at<=${asOf} AND(effective_from IS NULL OR effective_from<=${asOf}) ORDER BY document_id,number DESC`);return new Map(rows.map(row=>[row.documentId,row]));
  }
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
