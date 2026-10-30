import { randomUUID } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError } from "@/modules/finance/domain/employee-compensation-run";

const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),create:vi.fn(),read:vi.fn(),cancel:vi.fn(),capture:vi.fn(),list:vi.fn(),detail:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/employee-compensation-run-service",()=>({createEmployeeCompensationRun:boundary.create,getEmployeeCompensationRun:boundary.read,cancelEmployeeCompensationRun:boundary.cancel}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
vi.mock("@/modules/finance/application/employee-compensation-run-list",()=>({listEmployeeCompensationRuns:boundary.list}));
vi.mock("@/modules/finance/application/employee-compensation-run-detail",()=>({getEmployeeCompensationRunDetail:boundary.detail}));
import { POST as create } from "@/app/api/finance/compensation/runs/route";
import { GET as read } from "@/app/api/finance/compensation/runs/[runId]/route";
import { POST as cancel } from "@/app/api/finance/compensation/runs/[runId]/cancel/route";
import { GET as list } from "@/app/api/finance/compensation/runs/list/route";
import { GET as detail } from "@/app/api/finance/compensation/runs/[runId]/detail/route";

const actor={organizationId:randomUUID(),actorId:randomUUID()},id=randomUUID(),origin="http://localhost:3138";
const params=()=>({params:Promise.resolve({runId:id})});
const post=(path="",body="{}",headers:Record<string,string>={})=>new NextRequest(origin+"/api/finance/compensation/runs"+path,{method:"POST",body,headers:{origin,host:"localhost:3138","content-type":"application/json",...headers}});
const get=(query="")=>new NextRequest(origin+"/api/finance/compensation/runs/"+id+query);
const privateResponse=(response:Response)=>{expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");};

describe("private persisted compensation run HTTP boundary",()=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);
    boundary.create.mockResolvedValue({id,idempotent:false});boundary.read.mockResolvedValue({id});boundary.cancel.mockResolvedValue({id,idempotent:false});boundary.capture.mockResolvedValue(undefined);});
  it("requires the authenticated finance session on list and evidence detail",async()=>{
    boundary.actor.mockResolvedValue(null);
    for(const response of[await list(get()),await detail(get(),params())]){expect(response.status).toBe(401);expect(await response.json()).toEqual({error:"unauthorized"});privateResponse(response);}
    expect(boundary.list).not.toHaveBeenCalled();expect(boundary.detail).not.toHaveBeenCalled();
  });
  it("keeps evidence detail cursor validation and list query actor binding at the private HTTP boundary",async()=>{
    boundary.list.mockResolvedValue({runs:[],next:null,canCreate:false});boundary.detail.mockResolvedValue({id});
    const listed=await list(get("?query=Completed&state=draft"));expect(listed.status).toBe(200);privateResponse(listed);
    expect(boundary.list.mock.calls[0]?.slice(0,2)).toEqual([actor,{query:"Completed",state:"draft"}]);
    const response=await detail(get(),params());expect(response.status).toBe(200);privateResponse(response);expect(boundary.detail.mock.calls[0]?.slice(0,2)).toEqual([actor,{id}]);
    const rejected=await detail(get("?organizationId="+randomUUID()),params());expect(rejected.status).toBe(400);privateResponse(rejected);expect(boundary.detail).toHaveBeenCalledTimes(1);
  });
  it("requires the authenticated finance session on create, read and cancel",async()=>{
    boundary.actor.mockResolvedValue(null);
    for(const response of[await create(post()),await read(get(),params()),await cancel(post("/"+id+"/cancel"),params())]){
      expect(response.status).toBe(401);expect(await response.json()).toEqual({error:"unauthorized"});privateResponse(response);
    }
    expect(boundary.create).not.toHaveBeenCalled();expect(boundary.read).not.toHaveBeenCalled();expect(boundary.cancel).not.toHaveBeenCalled();
  });
  it.each([["origin","https://foreign.example"],["origin",""],["content-type","text/plain"]])("rejects untrusted write origin or type %#",async(key,value)=>{
    for(const response of[await create(post("","{}",{[key]:value})),await cancel(post("/"+id+"/cancel","{}",{[key]:value}),params())]){
      expect(response.status).toBe(403);privateResponse(response);
    }
    expect(boundary.create).not.toHaveBeenCalled();expect(boundary.cancel).not.toHaveBeenCalled();
  });
  it("bounds the actual large run request before any business writes",async()=>{
    const response=await create(post("",'"'+"x".repeat(2*1024*1024)+'"'));expect(response.status).toBe(400);privateResponse(response);expect(boundary.create).not.toHaveBeenCalled();
  });
  it("retains the session actor and a server audit identifier on creation",async()=>{
    const input={fromOn:"2026-10-30",toOn:"2026-10-30",currency:"MAD",jobs:[]},response=await create(post("",JSON.stringify(input),{"x-request-id":"forged-audit-identifier"}));
    expect(response.status).toBe(200);privateResponse(response);
    const meta=z.object({requestId:z.uuid()}).strict().parse(boundary.create.mock.calls[0]?.[2]);
    expect(boundary.create).toHaveBeenCalledWith(actor,input,meta);
  });
  it("awaits the route identity and accepts only the declared read cursor",async()=>{
    const after=randomUUID(),response=await read(get("?after="+after),params());expect(response.status).toBe(200);privateResponse(response);
    const meta=z.object({requestId:z.uuid()}).strict().parse(boundary.read.mock.calls[0]?.[2]);
    expect(boundary.read).toHaveBeenCalledWith(actor,{id,after},meta);
    const rejected=await read(get("?organizationId="+randomUUID()),params());expect(rejected.status).toBe(400);privateResponse(rejected);expect(boundary.read).toHaveBeenCalledTimes(1);
  });
  it("binds cancellation to the route identity and rejects actor or tenant body fields",async()=>{
    const input={reason:"Actual authorized cancellation"},response=await cancel(post("/"+id+"/cancel",JSON.stringify(input)),params());
    expect(response.status).toBe(200);privateResponse(response);const meta=z.object({requestId:z.uuid()}).strict().parse(boundary.cancel.mock.calls[0]?.[2]);expect(boundary.cancel).toHaveBeenCalledWith(actor,{id,...input},meta);
    const rejected=await cancel(post("/"+id+"/cancel",JSON.stringify({...input,actorId:randomUUID()})),params());
    expect(rejected.status).toBe(400);privateResponse(rejected);expect(boundary.cancel).toHaveBeenCalledTimes(1);
  });
  it.each([[new EmployeeCompensationRunAccessError(),403,"forbidden"],[new EmployeeCompensationRunConflictError(),409,"conflict"],
    [new EmployeeCompensationRunPolicyError(),409,"configuration_unavailable"],[new Error("private source 500.25 must not escape"),503,"unavailable"]] as const)("returns private generic run errors %#",async(error,status,message)=>{
    boundary.create.mockRejectedValue(error);const response=await create(post());expect(response.status).toBe(status);expect(await response.json()).toEqual({error:message});privateResponse(response);
  });
  it("retains the private unavailable response if telemetry delivery also fails",async()=>{
    boundary.create.mockRejectedValue(new Error("private source data"));boundary.capture.mockRejectedValue(new Error("telemetry transport failed"));
    const response=await create(post());expect(response.status).toBe(503);expect(await response.json()).toEqual({error:"unavailable"});privateResponse(response);
  });
});
