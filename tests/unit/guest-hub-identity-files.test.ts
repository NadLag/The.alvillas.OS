import {createHash,randomUUID} from "node:crypto";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
import {documentSingleBodyBytes,documentUploadChunkBytes} from "@/modules/documents/domain/document-upload-parts";
import {guestHubRequest} from "@/modules/guest-hub/ui/guest-hub-browser";
import {prepareGuestHubIdentityFile,uploadGuestHubIdentityFile} from "@/modules/guest-hub/ui/guest-hub-identity-files";

const signal=()=>new AbortController().signal,limit={maxBytes:10*1024*1024,contentTypes:["image/jpeg"]},original=Buffer.from([255,216,255,224,1,2,255,217]);
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
beforeEach(()=>vi.stubGlobal("navigator",{onLine:true}));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("transient native private identity browser file preparation and recovery",()=>{
 it("reviews exact original bytes without retaining or sending their original filename",async()=>{
  const file=new File([original],"private-original-person-name.jpg",{type:"image/jpeg"}),value=await prepareGuestHubIdentityFile(file,"PASSPORT","IDENTITY_PAGE",limit,signal());expect(value).toEqual({kind:"PASSPORT",part:"IDENTITY_PAGE",contentType:"image/jpeg",fileSize:original.length,sha256:digest(original)});expect(JSON.stringify(value)).not.toContain(file.name);expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(original));
 });
 it("rejects unapproved media, configured size violations and aborted selection before reading private bytes",async()=>{
  for(const file of[new File([original],"original.heic",{type:"image/heic"}),new File([],"empty.jpg",{type:"image/jpeg"}),new File([original],"large.jpg",{type:"image/jpeg"})]){const spy=vi.spyOn(file,"arrayBuffer");await expect(prepareGuestHubIdentityFile(file,"PASSPORT","IDENTITY_PAGE",{...limit,maxBytes:original.length-1},signal())).rejects.toMatchObject({state:"validation"});expect(spy).not.toHaveBeenCalled();}
  const file=new File([original],"aborted.jpg",{type:"image/jpeg"}),spy=vi.spyOn(file,"arrayBuffer"),controller=new AbortController();controller.abort();await expect(prepareGuestHubIdentityFile(file,"PASSPORT","IDENTITY_PAGE",limit,controller.signal)).rejects.toMatchObject({name:"AbortError"});expect(spy).not.toHaveBeenCalled();
 });
 it("retains canonical multipart count and exact chunk commitments above the existing single-body limit",async()=>{
  const bytes=Buffer.alloc(documentSingleBodyBytes+1,37),file=new File([bytes],"private-multipart.jpg",{type:"image/jpeg"}),value=await prepareGuestHubIdentityFile(file,"PASSPORT","IDENTITY_PAGE",limit,signal());expect(value.sha256).toBe(digest(bytes));expect(value.parts?.hashes).toEqual(Array.from({length:Math.ceil(bytes.length/documentUploadChunkBytes)},(_,index)=>digest(bytes.subarray(index*documentUploadChunkBytes,(index+1)*documentUploadChunkBytes))));expect(value.parts?.chunkBytes).toBe(documentUploadChunkBytes);
 });
 it("sends only bounded raw binary to closed native file paths with the original same-origin cookie boundary",async()=>{
  const linkId=randomUUID(),captureId=randomUUID(),item={id:randomUUID(),kind:"PASSPORT"as const,part:"IDENTITY_PAGE"as const},reply={captureId,fileId:item.id,kind:item.kind,part:item.part,state:"PUBLISHED",currentCapture:true,publishedAt:"2031-01-01T00:00:00.000Z"},requests:Array<{path:string;headers:Headers;bytes:Uint8Array}>=[];
  vi.stubGlobal("fetch",vi.fn<typeof fetch>((raw,init)=>{expect(init).toMatchObject({method:"POST",credentials:"same-origin",cache:"no-store"});const body=init?.body;if(!(body instanceof Uint8Array))throw Error("Original bounded binary body required");requests.push({path:typeof raw==="string"?raw:raw instanceof URL?raw.href:raw.url,headers:new Headers(init?.headers),bytes:new Uint8Array(body)});return Promise.resolve(Response.json(reply));}));expect(await uploadGuestHubIdentityFile(linkId,captureId,item,new File([original],"private-never-transmitted.jpg",{type:"image/jpeg"}),signal())).toEqual(reply);expect(requests).toHaveLength(1);expect(requests[0].path).toBe("/api/guest-hub/links/"+linkId+"/identity-documents/"+captureId+"/files/"+item.id+"/upload");expect(requests[0].headers.get("content-type")).toBe("application/octet-stream");expect([...requests[0].headers.keys()]).toEqual(["content-type"]);expect(requests[0].bytes).toEqual(new Uint8Array(original));
 });
 it("keeps an interrupted upload or completion uncertain and rejects mismatched publication acknowledgements",async()=>{
  const linkId=randomUUID(),captureId=randomUUID(),item={id:randomUUID(),kind:"PASSPORT"as const,part:"IDENTITY_PAGE"as const},path="links/"+linkId+"/identity-documents/"+captureId+"/files/"+item.id+"/";vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new TypeError("Owned interrupted original acknowledgement")));await expect(guestHubRequest(path+"upload",null,signal(),undefined,{binary:original})).rejects.toMatchObject({state:"uncertain"});await expect(guestHubRequest(path+"complete",{},signal())).rejects.toMatchObject({state:"uncertain"});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({captureId,fileId:randomUUID(),kind:item.kind,part:item.part,state:"PUBLISHED",currentCapture:true,publishedAt:"2031-01-01T00:00:00.000Z"})));await expect(uploadGuestHubIdentityFile(linkId,captureId,item,new File([original],"original.jpg",{type:"image/jpeg"}),signal())).rejects.toMatchObject({state:"uncertain"});
 });
 it("rejects query strings, foreign URLs, staff-selected binary authority and noncanonical part indices before fetch",async()=>{
  const prefix="links/"+randomUUID()+"/identity-documents/"+randomUUID()+"/files/"+randomUUID()+"/",fetch=vi.fn();vi.stubGlobal("fetch",fetch);for(const path of["https://foreign.example.test",prefix+"upload?token=not-permitted",prefix+"parts/00",prefix+"parts/-1",prefix+"status"]){await expect(guestHubRequest(path,null,signal(),undefined,{binary:original})).rejects.toMatchObject({state:"validation"});}await expect(guestHubRequest(prefix+"upload",null,signal(),"staff.scope",{binary:original})).rejects.toMatchObject({state:"validation"});expect(fetch).not.toHaveBeenCalled();
 });
});
