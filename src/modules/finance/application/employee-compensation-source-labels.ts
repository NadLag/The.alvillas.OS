import { employeeMonthlySourceEvidence } from "../domain/employee-monthly-evidence";
import type { employeeMonthlyEarningsWindow } from "../domain/employee-monthly-earnings";
import { z } from "zod";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import type { TenantTransaction } from "@/platform/db/tenant";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { localizedTextSchema } from "@/i18n/content";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { FinanceRepository } from "../infrastructure/finance-repository";
import type { EmployeeCompensationRunRepository,CompensationDisplaySource } from "../infrastructure/employee-compensation-run-repository";
import type { recheckFinanceAuthorization,FinanceActorContext } from "./finance-access";

/** Saved evidence and selectable work share the same independent human-label disclosure policy. */
export async function employeeCompensationSourceLabels(ctx:FinanceActorContext,tx:TenantTransaction,rows:readonly CompensationDisplaySource[],validators:Awaited<ReturnType<EmployeeCompensationRunRepository["people"]>>){
  const validatorMap=new Map(validators.map(person=>[person.id,person])),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now=await new FinanceRepository(tx,ctx.organizationId).clock();
  const checks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[];
  const can=(resource:Resource)=>[ctx.authContext,current].every(auth=>authorize(auth,"view",resource,now));
  const calendars=new Map<string,ReturnType<typeof employeeMonthlyEarningsWindow>>(),labels=rows.map(row=>{
    const completed=row.completionEvent?employeeCompletedWorkEvidence(row.completionEvent):null;if((row.earningKind??"PER_JOB")==="PER_JOB"&&!completed||row.earningKind==="PER_MONTH"&&(!row.earningPeriodKey||completed||!row.amount||!row.run||!row.compensation.currency||!row.contractWitnesses))throw new EmployeeCompensationRunAccessError();const scope={organizationId:ctx.organizationId,propertyId:row.propertyId,city:row.property?.cityId??row.sourceCity?.id,region:row.property?.regionId??row.sourceCity?.regionId??row.sourceRegion?.id};
    const personResource:Resource={...scope,type:"identity",id:row.personId,assignedPersonId:row.personId};
    const ownPerson=row.person.userAccounts.some(account=>account.id===ctx.actorId),personAllowed=ownPerson||can(personResource);
    if(personAllowed&&!ownPerson)checks.push({action:"view",resource:personResource});
    const propertyResource:Resource={...scope,type:"property",id:row.propertyId??undefined},propertyAllowed=Boolean(row.property&&row.propertyId&&can(propertyResource));
    if(propertyAllowed)checks.push({action:"view",resource:propertyResource});
    const taskResource:Resource={...scope,type:"task",id:row.taskId??undefined,taskId:row.taskId??undefined,jobId:row.taskId,status:row.task?.state,
      assignedPersonId:row.task?.assignedToPersonId,assignedUserAccountId:row.task?.assignedToUserAccountId},taskAllowed=Boolean(row.task&&row.taskId&&can(taskResource));
    if(taskAllowed)checks.push({action:"view",resource:taskResource});
    const title=taskAllowed?z.object({title_translations:localizedTextSchema}).safeParse(completed):null;
    const validator=completed?.validated_by_person_id?validatorMap.get(completed.validated_by_person_id):null;
    const validatorResource:Resource={...scope,type:"identity",id:validator?.id,assignedPersonId:validator?.id};
    const ownValidator=validator?.userAccounts.some(account=>account.id===ctx.actorId),validatorAllowed=Boolean(validator&&(ownValidator||can(validatorResource)));
    if(validatorAllowed&&!ownValidator)checks.push({action:"view",resource:validatorResource});
    return{...row.earningKind==="PER_MONTH"?{earningKind:"PER_MONTH" as const,earningPeriodKey:row.earningPeriodKey!,monthlyCoverage:employeeMonthlySourceEvidence({month:row.earningPeriodKey!,currency:row.compensation.currency!,amount:row.amount!,policySnapshot:row.run!.policySnapshot,witnesses:row.contractWitnesses!},calendars)}:{},lineId:row.id,personName:personAllowed?row.person.displayName:null,propertyName:propertyAllowed?row.property!.name:null,
      roleName:row.compensation.assignment.role.name,contractVersion:row.compensation.version,effectiveFrom:row.compensation.effectiveFrom.toISOString(),
      sourceTitle:title?.success?title.data.title_translations:null,canViewTask:taskAllowed,completionMethod:completed?.completion_source??null,validatorName:validatorAllowed?validator!.displayName:null,
      validatedAt:completed?.validated_at??null};
  });
  return{labels,checks,current};
}
