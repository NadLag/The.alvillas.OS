import { randomUUID } from "node:crypto";
import { beforeEach,describe,expect,it,vi } from "vitest";
import { NextRequest } from "next/server";
import { EmployeeCompensationRunAccessError } from "@/modules/finance/domain/employee-compensation-run";
const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),editor:vi.fn(),work:vi.fn(),recover:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/employee-compensation-picker",()=>({getEmployeeCompensationRunEditor:boundary.editor,listEmployeeCompensationWork:boundary.work}));
vi.mock("@/modules/finance/application/employee-compensation-run-recovery",()=>({recoverEmployeeCompensationRun:boundary.recover}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
import { GET as editor } from "@/app/api/finance/compensation/runs/editor/route";
import { GET as work } from "@/app/api/finance/compensation/runs/work/route";
import { POST as recover } from "@/app/api/finance/compensation/runs/recover/route";
const origin="http://localhost:3142",base=origin+"/api/finance/compensation/runs",actor={organizationId:randomUUID(),actorId:randomUUID()};
const privateResponse=(response:Response)=>{expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");};
const post=(body:string,from=origin)=>new NextRequest(base+"/recover",{method:"POST",headers:{origin:from,host:"localhost:3142","content-type":"application/json"},body});
describe("compensation work selection and acknowledgement recovery HTTP boundaries",()=>{
  beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);boundary.editor.mockResolvedValue({currencies:[]});boundary.work.mockResolvedValue({items:[]});boundary.recover.mockResolvedValue({run:null});});
  it("requires the actual finance session on editor, actual work selection and opaque nonce recovery",async()=>{
    boundary.actor.mockResolvedValue(null);
    for(const response of[await editor(new NextRequest(base+"/editor")),await work(new NextRequest(base+"/work")),await recover(post("{}"))]){expect(response.status).toBe(401);privateResponse(response);}
    expect(boundary.editor).not.toHaveBeenCalled();expect(boundary.work).not.toHaveBeenCalled();expect(boundary.recover).not.toHaveBeenCalled();
  });
  it("bounds recovery input and rejects foreign origins before looking up a nonce",async()=>{
    const denied=await recover(post(JSON.stringify({key:randomUUID()}),"https://foreign.example")),large=await recover(post(JSON.stringify({key:"x".repeat(1024)})));
    expect(denied.status).toBe(403);expect(large.status).toBe(400);privateResponse(denied);privateResponse(large);expect(boundary.recover).not.toHaveBeenCalled();
  });
  it("retains the session actor and rejects undeclared editor query fields",async()=>{
    const key=randomUUID(),response=await recover(post(JSON.stringify({key})));expect(response.status).toBe(200);privateResponse(response);expect(boundary.recover.mock.calls[0]?.slice(0,2)).toEqual([actor,{key}]);
    const options=await work(new NextRequest(base+"/work?fromOn=2026-10-30&toOn=2026-10-30&currency=MAD"));expect(options.status).toBe(200);privateResponse(options);expect(boundary.work.mock.calls[0]?.slice(0,2)).toEqual([actor,{fromOn:"2026-10-30",toOn:"2026-10-30",currency:"MAD"}]);
    const injected=await editor(new NextRequest(base+"/editor?organizationId="+randomUUID()));expect(injected.status).toBe(400);privateResponse(injected);expect(boundary.editor).not.toHaveBeenCalled();
  });
  it("returns a generic private denial when the actor cannot recover the original financial source",async()=>{
    boundary.recover.mockRejectedValue(new EmployeeCompensationRunAccessError());const response=await recover(post(JSON.stringify({key:randomUUID()})));expect(response.status).toBe(403);expect(await response.json()).toEqual({error:"forbidden"});privateResponse(response);
  });
});
