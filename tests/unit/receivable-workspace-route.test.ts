import {randomUUID} from "node:crypto";
import {beforeEach,describe,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
import {receivableSourcesInput,receivablePartiesInput,receivableHistoryInput} from "@/modules/finance/domain/receivable-workspace";
const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),editor:vi.fn(),sources:vi.fn(),parties:vi.fn(),history:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/receivable-workspace",()=>({getReceivableEditor:boundary.editor,getReceivableSources:boundary.sources,getReceivableParties:boundary.parties,getReceivableAssignmentHistory:boundary.history}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
import {GET as editor} from "@/app/api/finance/receivables/editor/route";
import {POST as sources} from "@/app/api/finance/receivables/sources/route";
import {POST as parties} from "@/app/api/finance/receivables/parties/route";
import {POST as history} from "@/app/api/finance/receivables/assignments/history/route";
const origin="http://localhost:3194",actor={organizationId:randomUUID(),actorId:randomUUID()},endpoints=[{path:"/sources",route:sources,mock:boundary.sources,input:{currency:"MAD"}},{path:"/parties",route:parties,mock:boundary.parties,input:{kind:"GUEST",search:""}},{path:"/assignments/history",route:history,mock:boundary.history,input:{}}];
const post=(path:string,input:unknown,from=origin,query="")=>new NextRequest(origin+"/api/finance/receivables"+path+query,{method:"POST",headers:{origin:from,host:"localhost:3194","content-type":"application/json"},body:JSON.stringify(input)});
function privateResponse(response:Response){expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");}
describe("private receivable source and debtor discovery routes",()=>{
 beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);boundary.editor.mockResolvedValue({source:{}});for(const [mock,schema]of[[boundary.sources,receivableSourcesInput],[boundary.parties,receivablePartiesInput],[boundary.history,receivableHistoryInput]] as const)mock.mockImplementation((_actor,input:unknown)=>{schema.parse(input);return Promise.resolve({source:{items:[],next:null}});});});
 it.each(endpoints)("passes the current actor and bounded private body for $path",async endpoint=>{const response=await endpoint.route(post(endpoint.path,endpoint.input));expect(response.status).toBe(200);privateResponse(response);expect(endpoint.mock.mock.calls[0]?.slice(0,2)).toEqual([actor,endpoint.input]);});
 it("denies unauthenticated editor and all financial discovery routes",async()=>{boundary.actor.mockResolvedValue(null);const response=await editor(new NextRequest(origin+"/api/finance/receivables/editor"));expect(response.status).toBe(401);privateResponse(response);expect(boundary.editor).not.toHaveBeenCalled();for(const endpoint of endpoints){expect((await endpoint.route(post(endpoint.path,endpoint.input))).status).toBe(401);expect(endpoint.mock).not.toHaveBeenCalled();}});
 it("rejects query identity, foreign origins and tenant/body substitution",async()=>{for(const endpoint of endpoints){for(const request of[post(endpoint.path,endpoint.input,"https://foreign.example"),post(endpoint.path,endpoint.input,origin,"?organizationId="+randomUUID())]){const response=await endpoint.route(request);expect([400,403]).toContain(response.status);privateResponse(response);}expect(endpoint.mock).not.toHaveBeenCalled();const response=await endpoint.route(post(endpoint.path,{...endpoint.input,organizationId:randomUUID()}));expect(response.status).toBe(400);privateResponse(response);}});
 it("keeps editor settings private and rejects query-supplied scope",async()=>{const response=await editor(new NextRequest(origin+"/api/finance/receivables/editor"));expect(response.status).toBe(200);privateResponse(response);expect(boundary.editor.mock.calls[0]?.[0]).toEqual(actor);expect((await editor(new NextRequest(origin+"/api/finance/receivables/editor?organizationId="+randomUUID()))).status).toBe(400);expect(boundary.editor).toHaveBeenCalledTimes(1);});
});
