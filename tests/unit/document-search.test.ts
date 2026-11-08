import { describe,expect,it } from "vitest";
import { documentSearchInputSchema,documentSearchResultSchema,literalDocumentSearchPattern } from "@/modules/documents/domain/document-search";

const input={query:"Original agreement",kind:"ALL",versionSelection:"CURRENT_EFFECTIVE",includeArchived:false};
describe("private native document metadata search",()=>{
  it("requires explicit version, kind and archive choices without inserting business defaults",()=>{expect(documentSearchInputSchema.parse(input)).toEqual(input);for(const key of["query","kind","versionSelection","includeArchived"]){const missing:Record<string,unknown>={...input};delete missing[key];expect(documentSearchInputSchema.safeParse(missing).success).toBe(false);}});
  it.each(["","   ","x".repeat(241)])("rejects an empty or oversized term %#",query=>{expect(documentSearchInputSchema.safeParse({...input,query}).success).toBe(false);});
  it.each(["Échéance de l’assurance","وثيقة أصلية","owner-contract.pdf"])("retains the entered multilingual metadata term %#",query=>{expect(documentSearchInputSchema.parse({...input,query:" "+query+" "}).query).toBe(query);expect(literalDocumentSearchPattern(query)).toBe("%"+query+"%");});
  it("keeps entered percent, underscore, backslash and SQL-looking text literal",()=>{expect(literalDocumentSearchPattern("50%_\\owner' OR TRUE--")).toBe("%50\\%\\_\\\\owner' OR TRUE--%");});
  it("rejects contradictory native source filters and injected tenant/storage/financial fields",()=>{expect(documentSearchInputSchema.safeParse({...input,source:{kind:"PROPERTY",id:"00000000-0000-4000-8000-000000000001"},sourceKind:"OWNER"}).success).toBe(false);for(const extra of[{organizationId:"foreign"},{storageKey:"private"},{balance:"9007199254740993.07"},{cursor:{before:"foreign"}}])expect(documentSearchInputSchema.safeParse({...input,...extra}).success).toBe(false);});
  it("does not publish raw match counts, object URLs or hidden facets in a result",()=>{const result={items:[],next:null,observedAt:"2026-11-07T20:00:00.000Z"};expect(documentSearchResultSchema.parse(result)).toEqual(result);for(const extra of[{total:500},{hiddenCount:499},{signedUrl:"https://foreign.example.test"},{facets:["private"]}])expect(documentSearchResultSchema.safeParse({...result,...extra}).success).toBe(false);});
});
