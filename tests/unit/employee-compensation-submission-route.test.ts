import { randomUUID } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { EmployeeCompensationClaimSourceError } from "@/modules/finance/domain/employee-compensation-claim";
import { ExpensePolicyUnavailableError } from "@/modules/finance/application/expense-submission-policy";

const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),request:vi.fn(),status:vi.fn(),detail:vi.fn(),withdraw:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/employee-compensation-submission-requests",()=>({requestEmployeeCompensationSubmission:boundary.request,getEmployeeCompensationSubmissionRequest:boundary.status}));
vi.mock("@/modules/finance/application/employee-compensation-submission",()=>({getEmployeeCompensationSubmission:boundary.detail,withdrawEmployeeCompensation:boundary.withdraw}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
import { POST as submit } from "@/app/api/finance/compensation/submissions/route";
import { GET as status } from "@/app/api/finance/compensation/submission-requests/[requestId]/route";
import { GET as detail } from "@/app/api/finance/compensation/submissions/[submissionId]/route";
import { POST as withdraw } from "@/app/api/finance/compensation/submissions/[submissionId]/withdraw/route";

const origin="http://localhost:3146",base=origin+"/api/finance/compensation",id=randomUUID(),actor={organizationId:randomUUID(),actorId:randomUUID()};
const post=(body="{}",from=origin)=>new NextRequest(base+"/submissions",{method:"POST",headers:{origin:from,host:"localhost:3146","content-type":"application/json"},body});
const get=(query="")=>new NextRequest(base+"/submissions/"+id+query);
const params=()=>({params:Promise.resolve({submissionId:id})}),requestParams=()=>({params:Promise.resolve({requestId:id})});
const privateResponse=(response:Response)=>{expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");};

describe("private durable employee compensation HTTP boundaries",()=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);boundary.request.mockResolvedValue({requestId:id,state:"PENDING"});boundary.status.mockResolvedValue({requestId:id});boundary.detail.mockResolvedValue({id});boundary.withdraw.mockResolvedValue({id});});
  it("requires the actual session on submission, status, evidence detail and withdrawal",async()=>{
    boundary.actor.mockResolvedValue(null);for(const response of[await submit(post()),await status(get(),requestParams()),await detail(get(),params()),await withdraw(post(),params())]){expect(response.status).toBe(401);privateResponse(response);}
    expect(boundary.request).not.toHaveBeenCalled();expect(boundary.status).not.toHaveBeenCalled();expect(boundary.detail).not.toHaveBeenCalled();expect(boundary.withdraw).not.toHaveBeenCalled();
  });
  it("returns accepted private work with the actual session actor and no body-supplied authority",async()=>{
    const input={runId:randomUUID(),costs:[],idempotencyKey:randomUUID()},response=await submit(post(JSON.stringify(input)));expect(response.status).toBe(202);privateResponse(response);
    expect(boundary.request.mock.calls[0]?.slice(0,2)).toEqual([actor,input]);const metadata:unknown=boundary.request.mock.calls[0]?.[2];expect(z.object({requestId:z.uuid()}).strict().safeParse(metadata).success).toBe(true);
  });
  it("rejects foreign origins and actual oversized bodies before persisting a request",async()=>{
    for(const response of[await submit(post("{}","https://foreign.example")),await submit(post(JSON.stringify({costs:"x".repeat(16*1024*1024)})))]){expect([400,403]).toContain(response.status);privateResponse(response);}expect(boundary.request).not.toHaveBeenCalled();
  });
  it("binds paged evidence to the path and rejects undeclared authority or withdrawal fields",async()=>{
    const after=randomUUID(),response=await detail(get("?after="+after),params());expect(response.status).toBe(200);privateResponse(response);expect(boundary.detail.mock.calls[0]?.slice(0,2)).toEqual([actor,{id,after}]);
    expect((await detail(get("?id="+randomUUID()),params())).status).toBe(400);expect(boundary.detail).toHaveBeenCalledTimes(1);
    expect((await withdraw(post(JSON.stringify({reason:"Withdraw only this actual proposal",actorId:randomUUID()})),params())).status).toBe(400);expect(boundary.withdraw).not.toHaveBeenCalled();
  });
  it.each([[new EmployeeCompensationClaimSourceError(),"source_unavailable"],[new ExpensePolicyUnavailableError("Private owner terms"),"configuration_unavailable"]] as const)("returns a generic private source or configuration conflict %#",async(error,message)=>{
    boundary.request.mockRejectedValue(error);const response=await submit(post());expect(response.status).toBe(409);expect(await response.json()).toEqual({error:message});privateResponse(response);
  });
});
