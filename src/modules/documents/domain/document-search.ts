import { z } from "zod";
import { documentSourceReferenceSchema } from "./document-command";
import { documentCategories, documentSourceKinds } from "./document-policy";
import { documentItemSchema, documentVersionItemSchema } from "./document-read-model";

export const documentSearchProtocol="ALVILLAS_DOCUMENT_SEARCH_V1";
export const documentSearchInputSchema=z.object({
  query:z.string().trim().min(1).max(240),
  kind:z.enum(["ALL","FILE","TEMPLATE","INSTANCE"]),
  versionSelection:z.enum(["CURRENT_EFFECTIVE","ALL"]),
  includeArchived:z.boolean(),
  source:documentSourceReferenceSchema.optional(),
  sourceKind:z.enum(documentSourceKinds).optional(),
  locale:z.enum(["en","fr","ar"]).optional(),
  category:z.enum(documentCategories).optional(),
  cursor:z.string().min(1).max(6000).optional()
}).strict().refine(value=>!value.source||!value.sourceKind||value.source.kind===value.sourceKind,{message:"document_search_source_must_match"});
export const documentSearchItemSchema=z.object({document:documentItemSchema,version:documentVersionItemSchema,sourceLabel:z.string(),state:z.enum(["CURRENT_EFFECTIVE","SCHEDULED","RETAINED"])}).strict()
  .refine(value=>value.document.id===value.version.documentId,{message:"document_search_original_version_required"});
export const documentSearchResultSchema=z.object({items:z.array(documentSearchItemSchema).max(20),next:z.string().nullable(),observedAt:z.iso.datetime()}).strict();

/** Parameterized ILIKE uses a literal term; entered wildcard characters never broaden the request. */
export function literalDocumentSearchPattern(raw:string){
  const query=documentSearchInputSchema.shape.query.parse(raw);
  return "%"+query.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_")+"%";
}
