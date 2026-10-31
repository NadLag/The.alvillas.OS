import { randomUUID } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
import { PaymentAccountChoiceAccessError,paymentAccountChoiceInputSchema } from "@/modules/finance/domain/payment-account-choices";
const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),work:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/payment-account-choices",()=>({listPaymentAccountChoices:boundary.work}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
import { POST } from "@/app/api/finance/payment-accounts/route";
const origin="http://localhost:3156",actor={organizationId:randomUUID(),actorId:randomUUID()},base=origin+"/api/finance/payment-accounts";
function post(body=JSON.stringify({source:{kind:"revenue"},query:""}),extra:{origin?:string;url?:string;contentType?:string}={}){return new NextRequest(extra.url??base,{method:"POST",headers:{origin:extra.origin??origin,host:"localhost:3156","content-type":extra.contentType??"application/json"},body});}
const privateResponse=(response:Response)=>{expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");};
describe("private payment-account search HTTP boundary",()=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);boundary.work.mockImplementation((_actor,input)=>{paymentAccountChoiceInputSchema.parse(input);return Promise.resolve({accounts:[],selected:null,next:null});});});
  it("requires an authenticated finance actor before reading accounts",async()=>{boundary.actor.mockResolvedValue(null);const response=await POST(post());expect(response.status).toBe(401);privateResponse(response);expect(boundary.work).not.toHaveBeenCalled();});
  it.each([{origin:"https://foreign.example"},{contentType:"text/plain"}])("rejects foreign origin or content type before source lookup: %j",async extra=>{const response=await POST(post(undefined,extra));expect(response.status).toBe(403);privateResponse(response);expect(boundary.work).not.toHaveBeenCalled();});
  it("bounds the POST and rejects URL filters without looking up accounts",async()=>{for(const request of[post("{"),post(JSON.stringify({query:"x".repeat(2100)})),post(undefined,{url:base+"?query=private"})]){const response=await POST(request);expect(response.status).toBe(400);privateResponse(response);}expect(boundary.work).not.toHaveBeenCalled();});
  it.each([{source:{kind:"revenue"},organizationId:randomUUID()},{source:{kind:"expense",propertyId:randomUUID(),actorId:randomUUID()}},{source:{kind:"revenue"},query:"x".repeat(121)},{source:{kind:"revenue"},after:42}])("rejects injected identity and invalid filters: %j",async input=>{const response=await POST(post(JSON.stringify(input)));expect(response.status).toBe(400);privateResponse(response);});
  it("preserves the real actor and private source search",async()=>{const input={source:{kind:"expense",propertyId:randomUUID()},query:"Actual bank",after:randomUUID(),selectedId:randomUUID()},response=await POST(post(JSON.stringify(input)));expect(response.status).toBe(200);privateResponse(response);expect(boundary.work.mock.calls[0]?.slice(0,2)).toEqual([actor,input]);});
  it("returns a private generic denial with no hidden account information",async()=>{boundary.work.mockRejectedValue(new PaymentAccountChoiceAccessError("Private hidden account"));const response=await POST(post());expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"forbidden"});privateResponse(response);expect(boundary.capture).not.toHaveBeenCalled();});
  it("returns a generic unavailable response for a backend failure",async()=>{boundary.work.mockRejectedValue(new Error("Sensitive backend detail"));const response=await POST(post());expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"unavailable"});privateResponse(response);});
});
