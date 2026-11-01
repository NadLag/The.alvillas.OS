import {randomUUID} from "node:crypto";
import {beforeEach,describe,expect,it,vi} from "vitest";
import {NextRequest} from "next/server";
import {z} from "zod";
import {EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError} from "@/modules/finance/domain/employee-compensation-run";
const boundary=vi.hoisted(()=>({auth:vi.fn(),actor:vi.fn(),read:vi.fn(),capture:vi.fn()}));
vi.mock("@/platform/auth/session",()=>({auth:boundary.auth}));
vi.mock("@/modules/finance/application/finance-access",()=>({financeActorContextFromSession:boundary.actor}));
vi.mock("@/modules/finance/application/employee-compensation-correction-workspace",()=>({getEmployeeCompensationCorrectionWorkspace:boundary.read}));
vi.mock("@/platform/observability/sentry",()=>({captureException:boundary.capture}));
import {GET} from "@/app/api/finance/compensation/submissions/[submissionId]/claims/[claimId]/correction/route";
const id=randomUUID(),claimId=randomUUID(),actor={organizationId:randomUUID(),actorId:randomUUID()},params={params:Promise.resolve({submissionId:id,claimId})},request=(query="")=>new NextRequest(`http://localhost:3194/api/finance/compensation/submissions/${id}/claims/${claimId}/correction${query}`);
function privateResponse(response:Response){expect(response.headers.get("cache-control")).toBe("private, no-store");expect(response.headers.get("vary")).toBe("Cookie, Origin");}
describe("private original employee correction workspace route",()=>{
 beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({user:{id:actor.actorId}});boundary.actor.mockResolvedValue(actor);boundary.read.mockResolvedValue({retained:"authorized-original-evidence"});});
 it("requires the actual financial session before loading original evidence",async()=>{boundary.actor.mockResolvedValue(null);const response=await GET(request(),params);expect(response.status).toBe(401);privateResponse(response);expect(boundary.read).not.toHaveBeenCalled();});
 it("binds both path identities and only bounded evidence and history cursors",async()=>{const after=randomUUID(),beforeRequest=randomUUID(),response=await GET(request(`?after=${after}&beforeRequest=${beforeRequest}`),params);expect(response.status).toBe(200);privateResponse(response);expect(boundary.read.mock.calls[0]?.slice(0,2)).toEqual([actor,{id,claimId,after,beforeRequest}]);expect(z.object({requestId:z.uuid()}).strict().safeParse(boundary.read.mock.calls[0]?.[2]).success).toBe(true);});
 it.each(["id","claimId","organizationId","amount","recognitionId"])("rejects query-supplied %s before source access",async field=>{const response=await GET(request(`?${field}=${randomUUID()}`),params);expect(response.status).toBe(400);privateResponse(response);expect(boundary.read).not.toHaveBeenCalled();});
 it("rejects malformed cursors before source access",async()=>{const response=await GET(request("?after=invalid"),params);expect(response.status).toBe(400);privateResponse(response);expect(boundary.read).not.toHaveBeenCalled();});
 it.each([[new EmployeeCompensationRunAccessError(),403,"forbidden"],[new EmployeeCompensationRunConflictError(),409,"conflict"],[new Error("Private salary and original income evidence"),503,"unavailable"]] as const)("keeps financial failure %# private",async(error,status,code)=>{boundary.read.mockRejectedValue(error);const response=await GET(request(),params);expect(response.status).toBe(status);expect(await response.json()).toEqual({error:code});privateResponse(response);});
});
