import type { TenantTransaction } from "@/platform/db/tenant";
import { calendarDateStart } from "@/platform/time/calendar";
import { employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import { employeeCompensationClaimCosts,employeeCompensationClaimPolicyInput } from "../domain/employee-compensation-claim";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

/** Request admission checks actual source authority without doing the long-running cost-policy work. */
export async function retainEmployeeClaimSourceAccess(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction,action:"view"|"edit"="edit"){
  const input=employeeCompensationClaimPolicyInput.parse(raw),repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
  const read=async()=>{
    const run=await repository.find(input.runId);if(!run||action!=="view"&&run.cancellation)throw new EmployeeCompensationRunAccessError();
    const facts=employeeCompensationRunFacts(ctx.organizationId,run);await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,action);
    const sources=await repository.claimSources(run.id);employeeCompensationClaimCosts(input,sources,run.currency);const starts=new Map<string,Date>();
    const checks=sources.flatMap(source=>{
      let at=starts.get(source.property.timezone);if(!at){at=calendarDateStart(input.costOn,source.property.timezone);starts.set(source.property.timezone,at);}
      const{financial}=employeeCompensationFinancialSourceFacts(ctx.organizationId,run.createdBy,{...source,reservationId:source.task.reservationId},at);
      const cost=[{action:"view" as const,resource:financial},{action:"view" as const,resource:{...financial,amount:facts.total.toJSON().amount}},
        {action:"view" as const,resource:{...financial,occurredAt:source.recordedCompletionAt}}];
      return source.task.reservation?[...cost,{action:"view" as const,resource:{...financial,type:"reservation",id:source.task.reservation.id,status:source.task.reservation.status,assignedUserAccountId:source.task.reservation.createdBy}}]:cost;
    });await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());
    return JSON.stringify({run,sources});
  };
  const original=await read();return async()=>{if(await read()!==original)throw new EmployeeCompensationRunAccessError();};
}
