import type { TenantTransaction } from "@/platform/db/tenant";
import { employeeEarningRequestAuthorityFacts,type EmployeeEarningRequestAuthorityRecord } from "@/platform/authz/employee-earning-request-resource";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { EmployeeEarningRunRequestRepository } from "../infrastructure/employee-earning-run-request-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
/** An opaque receipt retains the original actor and every actual original salary-source boundary. */
export async function retainEmployeeEarningRunRequestAccess(ctx:FinanceActorContext,row:EmployeeEarningRequestAuthorityRecord,tx:TenantTransaction){
 if(row.requestedBy!==ctx.actorId)throw new EmployeeCompensationRunAccessError();const facts=employeeEarningRequestAuthorityFacts(ctx.organizationId,row),checks=[{action:"view" as const,resource:facts.resource},...facts.salarySources.map(resource=>({action:"view" as const,resource}))];
 await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeCompensationRunAccessError());
 return async()=>{const current=await new EmployeeEarningRunRequestRepository(tx,ctx.organizationId).find(row.id);if(!current||employeeEarningRequestAuthorityFacts(ctx.organizationId,current).sourceIdentity!==facts.sourceIdentity)throw new EmployeeCompensationRunAccessError();await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeCompensationRunAccessError());};
}
