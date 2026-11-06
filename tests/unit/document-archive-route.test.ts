import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { DocumentAccessError,DocumentConfigurationError,DocumentConflictError,DocumentStorageError } from "@/modules/documents/domain/document-command";
const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),review:vi.fn(),admit:vi.fn(),recover:vi.fn(),history:vi.fn(),upload:vi.fn(),download:vi.fn(),sources:vi.fn(),read:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/platform/authz/session-context",()=>({accountActorContextFromSession:boundary.actor}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
vi.mock("@/modules/documents/application/document-archive",()=>({reviewDocumentUpload:boundary.review,admitDocumentUpload:boundary.admit,recoverDocumentUpload:boundary.recover,readDocumentHistory:boundary.history,uploadDocumentBytes:boundary.upload,downloadDocumentVersion:boundary.download}));
vi.mock("@/modules/documents/application/document-files",()=>({configuredDocumentObjects:()=>({})}));
vi.mock("@/modules/documents/application/document-workspace",()=>({readDocumentSources:boundary.sources,readDocumentSourceWorkspace:boundary.read}));
import { POST as review } from "@/app/api/documents/review/route";
import { POST as admit } from "@/app/api/documents/admit/route";
import { POST as recover } from "@/app/api/documents/recover/route";
import { POST as history } from "@/app/api/documents/history/route";
import { POST as upload } from "@/app/api/documents/upload/route";
import { POST as download } from "@/app/api/documents/download/route";
import { POST as sources } from "@/app/api/documents/sources/route";
import { POST as read } from "@/app/api/documents/read/route";
const origin="http://localhost:3194",actor={organizationId:randomUUID(),actorId:randomUUID()},nonce=randomUUID(),admissionId=randomUUID();
const routes=[{name:"review",post:review,service:boundary.review},{name:"admit",post:admit,service:boundary.admit},{name:"recover",post:recover,service:boundary.recover},{name:"history",post:history,service:boundary.history},{name:"upload",post:upload,service:boundary.upload},{name:"download",post:download,service:boundary.download},{name:"sources",post:sources,service:boundary.sources},{name:"read",post:read,service:boundary.read}];
function request(name:string,options:{origin?:string;type?:string;query?:string;body?:BodyInit}={}){
  return new NextRequest(origin+"/api/documents/"+name+(options.query??(name==="upload"?"?admissionId="+admissionId:"")),{method:"POST",headers:{origin:options.origin??origin,host:"localhost:3194","content-type":options.type??(name==="upload"?"application/octet-stream":"application/json")},body:options.body??(name==="upload"?new Uint8Array([1,2,3]):JSON.stringify({idempotencyKey:nonce}))});
}
function privateResponse(response:Response){expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");}
describe("private native document HTTP",()=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);for(const route of routes)route.service.mockResolvedValue({id:admissionId});boundary.download.mockResolvedValue({bytes:Buffer.from("%PDF-1.7\n%%EOF"),contentType:"application/pdf",fileName:"اتفاقية propriétaire.pdf"});});
  it.each(routes)("keeps $name authenticated and private",async route=>{const response=await route.post(request(route.name));expect(response.status).toBe(200);privateResponse(response);expect(route.service.mock.calls[0][0]).toBe(actor);});
  it.each(routes)("rejects unauthenticated $name before any business call",async route=>{boundary.actor.mockResolvedValue(null);const response=await route.post(request(route.name));expect(response.status).toBe(401);privateResponse(response);expect(route.service).not.toHaveBeenCalled();});
  it.each(routes)("rejects cross-origin $name before reading private intent",async route=>{const response=await route.post(request(route.name,{origin:"https://foreign.example.test"}));expect(response.status).toBe(403);privateResponse(response);expect(route.service).not.toHaveBeenCalled();});
  it.each(routes)("rejects wrong content type on $name",async route=>{const response=await route.post(request(route.name,{type:"text/plain"}));expect(response.status).toBe(403);privateResponse(response);expect(route.service).not.toHaveBeenCalled();});
  it.each(routes.filter(route=>route.name!=="upload"))("rejects query-supplied state on $name",async route=>{const response=await route.post(request(route.name,{query:"?organizationId="+randomUUID()}));expect(response.status).toBe(400);privateResponse(response);expect(route.service).not.toHaveBeenCalled();});
  it.each(["?admissionId="+admissionId+"&admissionId="+randomUUID(),"?admissionId="+admissionId+"&storageKey=foreign","?admissionId=invalid",""])("rejects ambiguous or injected binary admission references %#",async query=>{const response=await upload(request("upload",{query}));expect(response.status).toBe(400);privateResponse(response);expect(boundary.upload).not.toHaveBeenCalled();});
  it.each(["{",JSON.stringify({padding:"x".repeat(16384)}),new Uint8Array([123,34,120,34,58,34,255,34,125])])("bounds and strictly decodes JSON before business admission %#",async body=>{const response=await admit(request("admit",{body}));expect(response.status).toBe(400);privateResponse(response);expect(boundary.admit).not.toHaveBeenCalled();});
  it("bounds binary bytes before handing them to archive admission",async()=>{const response=await upload(request("upload",{body:new Uint8Array(10*1024*1024+1)}));expect(response.status).toBe(400);privateResponse(response);expect(boundary.upload).not.toHaveBeenCalled();});
  it.each([[new DocumentAccessError(),403,"forbidden"],[new DocumentConfigurationError(),409,"configuration_unavailable"],[new DocumentConflictError(),409,"conflict"],[new DocumentStorageError(),503,"storage_unavailable"]] as const)("returns only a private domain failure %#",async(error,status,code)=>{boundary.admit.mockRejectedValue(error);const response=await admit(request("admit"));expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});privateResponse(response);expect(boundary.capture).not.toHaveBeenCalled();});
  it("does not send unknown private error payloads to the response or telemetry",async()=>{boundary.admit.mockRejectedValue(new Error("PRIVATE contract reason / secret-storage-url"));const response=await admit(request("admit"));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"unavailable"});privateResponse(response);expect(boundary.capture.mock.calls[0][0]).toBeInstanceOf(Error);expect((boundary.capture.mock.calls[0][0] as Error).message).toBe("Document archive request failed");});
  it("downloads through a private sandboxed attachment response with the exact Unicode filename",async()=>{const response=await download(request("download"));privateResponse(response);expect(response.headers.get("content-type")).toBe("application/pdf");expect(response.headers.get("x-content-type-options")).toBe("nosniff");expect(response.headers.get("content-security-policy")).toBe("sandbox");expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''"+encodeURIComponent("اتفاقية propriétaire.pdf"));expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("%PDF-1.7\n%%EOF");});
  it("rejects an old browser account scope before reading or mutating document data",async()=>{const req=request("admit");req.headers.set("x-alvillas-document-scope",actor.organizationId+"."+randomUUID());const response=await admit(req);expect(response.status).toBe(403);privateResponse(response);expect(boundary.admit).not.toHaveBeenCalled();});
  it("accepts the actual current browser account scope",async()=>{const req=request("admit");req.headers.set("x-alvillas-document-scope",actor.organizationId+"."+actor.actorId);expect((await admit(req)).status).toBe(200);expect(boundary.admit).toHaveBeenCalledOnce();});
});
