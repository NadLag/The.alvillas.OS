import type { TenantTransaction } from "@/platform/db/tenant";
import { employeeMonthlyRequestAuthorityFacts,type EmployeeMonthlyRequestAuthorityRecord } from "@/platform/authz/employee-monthly-request-resource";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

/** A receipt does not grant access. Derive scope from actual historical assignments and contracts on every read. */
export async function retainEmployeeMonthlyRunRequestAccess(ctx:FinanceActorContext,request:EmployeeMonthlyRequestAuthorityRecord,tx:TenantTransaction){
  if(request.requestedBy!==ctx.actorId)throw new EmployeeCompensationRunAccessError();
  const facts=(await employeeMonthlyRequestAuthorityFacts(ctx.organizationId,[request],tx)).get(request.id);if(!facts)throw new EmployeeCompensationRunAccessError();
  const checks:Parameters<typeof recheckFinanceAuthorization>[3]=[{action:"view",resource:facts.resource,organizationOnly:facts.legacy},...facts.salarySources.map(resource=>({action:"view" as const,resource,organizationOnly:facts.legacy}))];
  await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeCompensationRunAccessError());
  return async()=>{const current=(await employeeMonthlyRequestAuthorityFacts(ctx.organizationId,[request],tx)).get(request.id);if(!current||current.sourceIdentity!==facts.sourceIdentity)throw new EmployeeCompensationRunAccessError();await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeCompensationRunAccessError());};
}
