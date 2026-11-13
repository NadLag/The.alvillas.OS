import {randomUUID} from "node:crypto";
import {NextRequest} from "next/server";
import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),transaction:vi.fn(),telemetry:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:mocks.auth}));
vi.mock("@/platform/authz/session-context",()=>({accountActorContextFromSession:mocks.actor}));
vi.mock("@/platform/db/client",()=>({prisma:{$transaction:mocks.transaction}}));
vi.mock("@/platform/observability/sentry",()=>({captureException:mocks.telemetry}));
import {POST as review} from "@/app/api/onboarding/activation/review/route";
import {POST as admit} from "@/app/api/onboarding/activation/admit/route";
import {POST as recover} from "@/app/api/onboarding/activation/recover/route";
import {POST as readiness} from "@/app/api/onboarding/readiness/route";
import {POST as status} from "@/app/api/onboarding/activation/status/route";

const organizationId=randomUUID(),actorId=randomUUID(),sessionId=randomUUID(),reviewId=randomUUID(),propertyId=randomUUID(),nonce=randomUUID(),scope=organizationId+"."+actorId,origin="http://localhost:3000";
const actor={organizationId,actorId,authContext:{organizationId,userAccountId:actorId,permissions:new Set(["onboarding:view","onboarding:edit","onboarding:approve","onboarding:export"]),scopes:[{organizationId,scopeType:"organization"as const}]}};
const draft={sessionId,previousRevisionId:reviewId,step:"ACTIVATE",target:{mode:"BACKGROUND",propertyId}};
const endpoints=[
 {path:"activation/review",post:review,input:draft},
 {path:"activation/admit",post:admit,input:{...draft,idempotencyKey:nonce,reviewFingerprint:"a".repeat(64),reason:"Explicit reviewed native activation"}},
 {path:"activation/recover",post:recover,input:{sessionId,idempotencyKey:nonce}},
 {path:"readiness",post:readiness,input:{sessionId,reviewRevisionId:reviewId,packageId:randomUUID()}},
 {path:"activation/status",post:status,input:{sessionId,idempotencyKey:nonce}}
];
function request(path:string,body:unknown,headers:Record<string,string>={},query=""){return new NextRequest(origin+"/api/onboarding/"+path+query,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","x-alvillas-onboarding-scope":scope,...headers},body:typeof body==="string"?body:JSON.stringify(body)});}
beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockResolvedValue({user:{id:actorId}});mocks.actor.mockResolvedValue(actor);mocks.telemetry.mockResolvedValue(undefined);mocks.transaction.mockRejectedValue(new Error("Unexpected private database access"));});

describe.each(endpoints)("private native $path boundary",({path,post,input})=>{
 it("denies an unauthenticated request before database or job access",async()=>{mocks.actor.mockResolvedValue(null);const response=await post(request(path,input));expect(response.status).toBe(401);expect(await response.json()).toEqual({error:"unauthorized"});expect(mocks.transaction).not.toHaveBeenCalled();expect(response.headers.get("cache-control")).toBe("private, no-store");});
 it.each<Record<string,string>>([{Origin:"https://foreign.example.test"},{"x-alvillas-onboarding-scope":randomUUID()+"."+actorId},{"Content-Type":"text/plain"}])("denies foreign origin, account scope or content type before native work: %j",async headers=>{const response=await post(request(path,input,headers));expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"forbidden"});expect(mocks.transaction).not.toHaveBeenCalled();expect(response.headers.get("vary")).toBe("Cookie, Origin");});
 it.each(["query","malformed","oversized"])("rejects %s input before native work",async kind=>{const response=await post(request(path,kind==="malformed"?"{":kind==="oversized"?{reason:"x".repeat(65537)}:input,{},kind==="query"?"?organizationId="+organizationId:""));expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"validation"});expect(mocks.transaction).not.toHaveBeenCalled();});
 it("rejects client authority and completion claims through the actual domain parser",async()=>{const response=await post(request(path,{...input,organizationId:randomUUID(),actorId:randomUUID(),completed:["WORKFLOWS","DOCUMENTS","EMAIL","TASKS","NOTIFICATION"],operational:true,state:"COMPLETE"}));expect(response.status).toBe(400);expect(await response.json()).toEqual({error:"validation"});expect(mocks.transaction).not.toHaveBeenCalled();expect(mocks.telemetry).not.toHaveBeenCalled();});
});
