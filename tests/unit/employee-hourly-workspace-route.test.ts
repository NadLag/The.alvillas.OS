import { randomUUID } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "@/modules/finance/domain/employee-compensation-run";
const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),editor:vi.fn(),work:vi.fn(),review:vi.fn(),request:vi.fn(),status:vi.fn(),recover:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/employee-hourly-workspace",()=>({getEmployeeHourlyRunEditor:boundary.editor,listEmployeeHourlyWork:boundary.work,reviewEmployeeHourlyRun:boundary.review}));
vi.mock("@/modules/finance/application/employee-earning-run-requests",()=>({requestEmployeeHourlyRun:boundary.request,getEmployeeEarningRunRequest:boundary.status,recoverEmployeeEarningRunRequest:boundary.recover}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
import { GET as editor } from "@/app/api/finance/compensation/runs/hourly/editor/route";
import { POST as work } from "@/app/api/finance/compensation/runs/hourly/work/route";
import { POST as review } from "@/app/api/finance/compensation/runs/hourly/review/route";
import { POST as request } from "@/app/api/finance/compensation/runs/hourly/requests/route";
import { GET as status } from "@/app/api/finance/compensation/runs/hourly/requests/[id]/route";
import { POST as recover } from "@/app/api/finance/compensation/runs/hourly/requests/recover/route";
const origin="http://localhost:3163",base=origin+"/api/finance/compensation/runs/hourly",id=randomUUID(),actor={organizationId:randomUUID(),actorId:randomUUID()};
const routes=[{path:"editor",method:"GET",handler:editor,spy:boundary.editor},{path:"work",method:"POST",handler:work,spy:boundary.work},{path:"review",method:"POST",handler:review,spy:boundary.review},{path:"requests",method:"POST",handler:request,spy:boundary.request},{path:`requests/${id}`,method:"GET",handler:(req:NextRequest)=>status(req,{params:Promise.resolve({id})}),spy:boundary.status},{path:"requests/recover",method:"POST",handler:recover,spy:boundary.recover}];
const make=(route:typeof routes[number],options:{body?:string;origin?:string;query?:string}={})=>new NextRequest(base+"/"+route.path+(options.query??""),{method:route.method,...route.method==="POST"?{headers:{origin:options.origin??origin,host:"localhost:3163","content-type":"application/json"},body:options.body??"{}"}:{}});
const privateResponse=(response:Response)=>{expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");};
describe("hourly picker, complete review and durable creation HTTP boundaries",()=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);for(const route of routes)route.spy.mockResolvedValue({accepted:true});});
  for(const route of routes){
    it(`${route.path} requires the actual finance actor and keeps all errors private`,async()=>{boundary.actor.mockResolvedValue(null);const response=await route.handler(make(route));expect(response.status).toBe(401);privateResponse(response);expect(route.spy).not.toHaveBeenCalled();});
    it(`${route.path} rejects private query inputs before reading work or commands`,async()=>{const response=await route.handler(make(route,{query:"?month=2026-01&search=private-employee"}));expect(response.status).toBe(400);privateResponse(response);expect(route.spy).not.toHaveBeenCalled();});
    it(`${route.path} preserves the session actor and reports only bounded source errors`,async()=>{const response=await route.handler(make(route));expect(response.status).toBe(route.path==="requests"?202:200);privateResponse(response);expect(route.spy.mock.calls[0][0]).toEqual(actor);route.spy.mockRejectedValueOnce(new EmployeeCompensationRunAccessError());const denied=await route.handler(make(route));expect(denied.status).toBe(403);expect(await denied.json()).toEqual({error:"forbidden"});privateResponse(denied);route.spy.mockRejectedValueOnce(new EmployeeCompensationRunConflictError());expect((await route.handler(make(route))).status).toBe(409);route.spy.mockRejectedValueOnce(new Error("private original contractual rate"));const unavailable=await route.handler(make(route));expect(unavailable.status).toBe(503);expect(await unavailable.json()).toEqual({error:"unavailable"});privateResponse(unavailable);});
    if(route.method==="POST")it(`${route.path} rejects cross-origin, malformed and oversized financial intent`,async()=>{for(const options of[{origin:"https://foreign.example"},{body:"{"},{body:JSON.stringify({data:"x".repeat(3200000)})}]){const response=await route.handler(make(route,options));expect([400,403]).toContain(response.status);privateResponse(response);}expect(route.spy).not.toHaveBeenCalled();});
  }
  it("retains every canonical source reference at the maximum selection size within the private body limit",async()=>{
    const body=JSON.stringify({fromOn:"2026-10-01",toOn:"2026-10-31",currency:"MAD",jobs:Array.from({length:10000},()=>({taskId:randomUUID(),assignmentId:randomUUID(),evidenceId:randomUUID(),decisionId:randomUUID(),confirmedAssignment:true})),purpose:"Actual complete source selection",reason:"Retain all canonical references within a bounded private body",reviewFingerprint:"a".repeat(64),idempotencyKey:randomUUID()});
    for(const route of routes.filter(route=>route.path==="review"||route.path==="requests")){const response=await route.handler(make(route,{body}));expect(response.status).toBe(route.path==="requests"?202:200);privateResponse(response);expect(route.spy.mock.calls[0][1]).toEqual(JSON.parse(body));}
  });
});
