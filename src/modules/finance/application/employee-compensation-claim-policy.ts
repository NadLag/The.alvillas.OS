import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { employeeCompensationFinancialSourceFacts } from "@/platform/authz/employee-compensation-resource";
import { calendarDateStart } from "@/platform/time/calendar";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { Money } from "@/platform/money/money";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import type { ExpenseEmergencyNotice } from "../domain/expense";
import { employeeCompensationClaimCosts,employeeCompensationClaimPolicyInput,EmployeeCompensationClaimSourceError } from "../domain/employee-compensation-claim";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { preparePropertyCostSubmissionPolicy,type FinancialPolicyStage,ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { financePolicyRoleKeys } from "./finance-config-service";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
import { retainCurrentEmployeeClaimWork } from "./employee-compensation-claim-source";

const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const reservationEvidence=z.object({reservation_id:z.uuid().nullable()}).passthrough();

/** Actual completed-work costs use the same property/agreement allocation and approval engine as other costs. */
export async function prepareEmployeeCompensationClaimPolicy(ctx:FinanceActorContext,raw:unknown,tx:TenantTransaction){
  const input=employeeCompensationClaimPolicyInput.parse(raw),repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
  await repository.lock(input.runId);requireCurrentTimezoneData();
  const build=async()=>{
    const pendingNotices:Array<{notice:ExpenseEmergencyNotice;resource:Resource}>=[];
    const run=await repository.find(input.runId);if(!run||run.cancellation)throw new EmployeeCompensationRunAccessError();
    const facts=employeeCompensationRunFacts(ctx.organizationId,run),now=await finance.clock();await recheckEmployeeCompensationRun(ctx,tx,now,facts,"edit");
    const recheckWork=await retainCurrentEmployeeClaimWork(ctx.organizationId,run,tx);
    const sources=await repository.claimSources(run.id),classified=employeeCompensationClaimCosts(input,sources,run.currency);
    if(sources.length!==run.lines.length||!classified.total.equals(facts.total)||sources.some(source=>!run.lines.some(line=>line.id===source.id&&line.taskId===source.taskId&&line.personId===source.personId&&line.completionEventId===source.completionEventId)))throw new EmployeeCompensationClaimSourceError();
    const current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),authorities=[ctx.authContext,current];
    const checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[];
    const requireRead=(resource:Resource)=>{checks.push({action:"view",resource});if(authorities.some(auth=>!authorize(auth,"view",resource,now)))throw new EmployeeCompensationRunAccessError();};
    const stages:Array<FinancialPolicyStage&{runLineId:string;propertyId:string;reservationId:string|null}>=[],costs=[];
    const roleChecks:Array<{resource:Resource;roles:string[]}>=[],starts=new Map<string,Date>();
    for(const item of classified.costs){
      const source=item.source,evidence=employeeCompletedWorkEvidence(source.completionEvent),reservationId=reservationEvidence.parse(evidence).reservation_id;
      if(evidence.property_id!==source.propertyId||evidence.completed_by_person_id!==source.personId||source.task.propertyId!==source.propertyId||source.task.reservationId!==reservationId||
        (reservationId&&(!source.task.reservation||source.task.reservation.propertyId!==source.propertyId)))throw new EmployeeCompensationClaimSourceError();
      let at=starts.get(source.property.timezone);if(!at){at=calendarDateStart(input.costOn,source.property.timezone);starts.set(source.property.timezone,at);}
      const{scope,financial}=employeeCompensationFinancialSourceFacts(ctx.organizationId,run.createdBy,{...source,reservationId},at);
      requireRead(financial);requireRead({...financial,amount:classified.total.toJSON().amount});requireRead({...financial,occurredAt:source.recordedCompletionAt});
      if(reservationId)requireRead({...scope,type:"reservation",id:reservationId,status:source.task.reservation!.status,assignedUserAccountId:source.task.reservation!.createdBy});
      const target:Resource={...scope,type:"expense",id:source.id,financialRecordId:source.id,amount:item.amount.toJSON().amount,occurredAt:at,status:"DRAFT"};
      const roles=financePolicyRoleKeys(ctx,target,now,authorities);roleChecks.push({resource:target,roles});
      const plan=await preparePropertyCostSubmissionPolicy(ctx,{id:source.id,propertyId:source.propertyId,reservationId,amount:source.amount,currency:source.currency,
        occurredOn:new Date(input.costOn+"T00:00:00Z"),category:item.category,emergency:input.emergency,purpose:item.note,property:{timezone:source.property.timezone}},target,tx,now,
        {sourceKind:"employee_compensation_run_line",runId:run.id,runLineId:source.id,completionEventId:source.completionEventId,personId:source.personId,
          recordedCompletionAt:source.recordedCompletionAt.toISOString(),actorRoles:roles},{approvalAmount:classified.total,discloseOwnerSlice:true,authorities,postHocAudience:(notice,resource)=>pendingNotices.push({notice,resource})});
      const frozen=z.object({allocation:z.object({owner:z.object({amount:z.string()}),alvillas:z.object({amount:z.string()}),guest:z.object({amount:z.string()})}),
        policies:z.array(z.object({revenueEvidence:z.object({amount:z.object({amount:z.string()})}).nullable().optional()}))}).passthrough().parse(plan.snapshot);
      if(item.amount.currency!==run.currency)throw new EmployeeCompensationClaimSourceError();
      if(Money.of(frozen.allocation.guest.amount,run.currency).amount.gt(0)&&!reservationId)throw new ExpensePolicyUnavailableError("Guest work allocation requires its original reservation");
      for(const policy of frozen.policies)if(policy.revenueEvidence)requireRead({...financial,amount:policy.revenueEvidence.amount.amount});
      stages.push(...plan.stages.map(stage=>({...stage,runLineId:source.id,propertyId:source.propertyId,reservationId})));
      costs.push({runLineId:source.id,personId:source.personId,propertyId:source.propertyId,reservationId,taskId:source.taskId,completionEventId:source.completionEventId,
        recordedCompletionAt:source.recordedCompletionAt.toISOString(),costOn:input.costOn,timezone:source.property.timezone,category:item.category,costCenter:item.costCenter,note:item.note,
        amount:item.amount.toJSON(),policy:plan.snapshot,postHocNotices:plan.postHocNotices});
    }
    const audiences=await new NotificationRepository(tx,ctx.organizationId).viewerAudiences(pendingNotices.map(row=>({routing:row.notice.routing,resource:row.resource})));
    for(const[index,row]of pendingNotices.entries()){if(!audiences[index].length)throw new ExpensePolicyUnavailableError("Emergency approval has no authorized owner notice recipient");row.notice.recipients.push(...audiences[index]);}
    for(const cost of costs)cost.policy=json({...cost.policy,postHocNotices:cost.postHocNotices});
    const final=await repository.find(run.id),finalSources=await repository.claimSources(run.id);
    if(JSON.stringify(final)!==JSON.stringify(run)||JSON.stringify(finalSources)!==JSON.stringify(sources))throw new EmployeeCompensationRunAccessError();
    const latest=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),at=await finance.clock();
    if(roleChecks.some(check=>JSON.stringify(check.roles)!==JSON.stringify(financePolicyRoleKeys(ctx,check.resource,at,[ctx.authContext,latest]))))throw new EmployeeCompensationRunAccessError();
    await recheckWork();await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new EmployeeCompensationRunAccessError());await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,"edit");
    return{runId:run.id,total:classified.total.toJSON(),costOn:input.costOn,costs,stages,snapshot:json({schemaVersion:1,kind:"EMPLOYEE_COMPENSATION_COSTS",runId:run.id,total:classified.total.toJSON(),costOn:input.costOn,costs})};
  };
  const captured=await build();
  return{...captured,recheck:async()=>{if(JSON.stringify(await build())!==JSON.stringify(captured))throw new EmployeeCompensationRunAccessError();}};
}
