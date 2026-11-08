import {randomUUID} from "node:crypto";
import {NextRequest} from "next/server";
import {beforeEach,describe,expect,it,vi} from "vitest";
import {LeadAccessError,LeadConfigurationError,LeadConflictError,LeadRateLimitError,LeadValidationError,leadCaptureInputSchema} from "@/modules/crm/domain/lead-capture";

const mocks=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),telemetry:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:mocks.auth}));
vi.mock("@/platform/authz/session-context",()=>({accountActorContextFromSession:mocks.actor}));
vi.mock("@/platform/observability/sentry",()=>({captureException:mocks.telemetry}));
import {leadHttp,websiteLeadHttp} from "@/modules/crm/ui/lead-http";

const organizationId=randomUUID(),actorId=randomUUID(),actor={organizationId,actorId,authContext:{organizationId,userAccountId:actorId,permissions:new Set(["lead:create","lead:view"]),scopes:[{organizationId,scopeType:"organization" as const}]}},origin="http://localhost:3000";
const input=()=>({idempotencyKey:randomUUID(),channel:"MANUAL",sourceKey:"assessment",locale:"fr",fields:{ownerContact:"Private claimant",email:"private-claim@example.test"}});
const request=(body=JSON.stringify(input()),headers:Record<string,string>={},query="")=>new NextRequest(origin+"/api/crm/leads/capture"+query,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json",...headers},body});
const rejectedHeaders:Record<string,string>[]=[{Origin:"https://foreign.example.test"},{"Content-Type":"text/plain"},{"x-alvillas-crm-scope":randomUUID()+"."+randomUUID()}];
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({user:{id:actorId}});mocks.actor.mockResolvedValue(actor);mocks.telemetry.mockResolvedValue(undefined);});

describe("private native lead HTTP boundaries",()=>{
  it("requires a real current session before accepting a private command",async()=>{
    mocks.actor.mockResolvedValue(null);const work=vi.fn(),response=await leadHttp(request(),work);
    expect(response.status).toBe(401);expect(response.headers.get("cache-control")).toBe("private, no-store");expect(work).not.toHaveBeenCalled();
  });
  it.each(rejectedHeaders)("rejects a foreign origin, body type or stale scope: %j",async headers=>{
    const work=vi.fn(),response=await leadHttp(request(undefined,headers),work);expect(response.status).toBe(403);expect(work).not.toHaveBeenCalled();
  });
  it("rejects query parameters and malformed or oversized bodies before native work",async()=>{
    for(const value of [request(undefined,{},"?organizationId="+randomUUID()),request("{"),request(JSON.stringify({notes:"x".repeat(32769)}))]){
      const work=vi.fn(),response=await leadHttp(value,work);expect(response.status).toBe(400);expect(work).not.toHaveBeenCalled();
    }
  });
  it("uses the held session identity and a server request ID instead of trusting body authority",async()=>{
    const work=vi.fn((selected,raw,requestId)=>{expect(selected).toBe(actor);expect(typeof requestId).toBe("string");leadCaptureInputSchema.parse(raw);return Promise.resolve({id:randomUUID()});});
    const response=await leadHttp(request(),work);expect(response.status).toBe(200);expect(response.headers.get("vary")).toBe("Cookie, Origin");expect(work).toHaveBeenCalledTimes(1);
    const forged=await leadHttp(request(JSON.stringify({...input(),organizationId:randomUUID(),actorId:randomUUID()})),work);expect(forged.status).toBe(400);
  });
  it.each([{error:new LeadAccessError(),status:403,code:"forbidden"},{error:new LeadValidationError(),status:400,code:"validation"},{error:new LeadConflictError(),status:409,code:"conflict"},{error:new LeadConfigurationError(),status:503,code:"configuration_unavailable"}])("keeps domain failures private: $code",async({error,status,code})=>{
    const response=await leadHttp(request(),()=>Promise.reject(error));expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("reports the configured rate-limit reset without exposing request details",async()=>{
    const response=await leadHttp(request(),()=>Promise.reject(new LeadRateLimitError(new Date(Date.now()+41000))));expect(response.status).toBe(429);expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);expect(await response.json()).toEqual({error:"rate_limited"});
  });
  it("sanitizes unexpected native and session errors before telemetry or HTTP publication",async()=>{
    const sensitive="private-claim@example.test : secret provider detail";
    const response=await leadHttp(request(),()=>Promise.reject(new Error(sensitive)));expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain(sensitive);
    const first=mocks.telemetry.mock.calls[0];expect((first[0] as Error).message).toBe("Private lead request failed");expect(JSON.stringify(first)).not.toContain(sensitive);
    mocks.auth.mockRejectedValue(new Error(sensitive));const work=vi.fn(),denied=await leadHttp(request(),work);expect(denied.status).toBe(503);expect(work).not.toHaveBeenCalled();expect((mocks.telemetry.mock.calls.at(-1)![0] as Error).message).toBe("Private lead session unavailable");
  });
});

describe("non-identifying public assessment acceptance",()=>{
  it("returns a bounded acknowledgement while retaining the actual durable result only on the server",async()=>{
    const privateId=randomUUID(),response=await websiteLeadHttp(request(JSON.stringify({...input(),channel:"WEBSITE"})),()=>Promise.resolve({id:privateId,fields:{email:"private-claim@example.test"}}));
    expect(response.status).toBe(202);expect(await response.json()).toEqual({accepted:true});expect(response.headers.get("cache-control")).toBe("private, no-store");expect(mocks.auth).not.toHaveBeenCalled();expect(mocks.actor).not.toHaveBeenCalled();
  });
  it("fails closed on unavailable processing configuration or principal authority",async()=>{
    for(const error of [new LeadAccessError(),new LeadConfigurationError()]){const response=await websiteLeadHttp(request(),()=>Promise.reject(error));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"configuration_unavailable"});}
  });
  it("retains origin and exact JSON boundaries for public requests",async()=>{
    const work=vi.fn(),response=await websiteLeadHttp(request(undefined,{Origin:"https://foreign.example.test"}),work);expect(response.status).toBe(403);expect(work).not.toHaveBeenCalled();
  });
});
