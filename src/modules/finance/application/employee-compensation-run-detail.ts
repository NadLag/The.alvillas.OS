import { z } from "zod";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize,type Resource } from "@/platform/authz/authorize";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { localizedTextSchema } from "@/i18n/content";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { employeeCompensationRunDetailSchema } from "../domain/employee-compensation-workspace";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeCompensationRunReadInput,readEmployeeCompensationRunInTransaction } from "./employee-compensation-run-service";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

/** Human source labels remain independently protected from salary and run access. */
export async function getEmployeeCompensationRunDetail(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=employeeCompensationRunReadInput.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const {model,record}=await readEmployeeCompensationRunInTransaction(ctx,input,tx,deps),repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId);
    const rows=await repository.displayLines(record.id,model.lines.map(line=>line.id));
    const evidence=new Map(rows.map(row=>[row.id,employeeCompletedWorkEvidence(row.completionEvent)]));
    const validators=await repository.people([...evidence.values()].flatMap(value=>value.validated_by_person_id?[value.validated_by_person_id]:[]));
    const validatorMap=new Map(validators.map(person=>[person.id,person])),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),now=await new FinanceRepository(tx,ctx.organizationId).clock();
    const metadataChecks:Parameters<typeof recheckFinanceAuthorization>[3][number][]=[];
    const can=(resource:Resource)=>[ctx.authContext,current].every(auth=>authorize(auth,"view",resource,now));
    const labels=rows.map(row=>{
      const completed=evidence.get(row.id)!,scope={organizationId:ctx.organizationId,propertyId:row.propertyId,city:row.property.cityId,region:row.property.regionId};
      const personResource:Resource={...scope,type:"identity",id:row.personId,assignedPersonId:row.personId};
      const ownPerson=row.person.userAccounts.some(account=>account.id===ctx.actorId),personAllowed=ownPerson||can(personResource);
      if(personAllowed&&!ownPerson)metadataChecks.push({action:"view",resource:personResource});
      const propertyResource:Resource={...scope,type:"property",id:row.propertyId},propertyAllowed=can(propertyResource);
      if(propertyAllowed)metadataChecks.push({action:"view",resource:propertyResource});
      const taskResource:Resource={...scope,type:"task",id:row.taskId,taskId:row.taskId,jobId:row.taskId,status:row.task.state,
        assignedPersonId:row.task.assignedToPersonId,assignedUserAccountId:row.task.assignedToUserAccountId},taskAllowed=can(taskResource);
      if(taskAllowed)metadataChecks.push({action:"view",resource:taskResource});
      const title=taskAllowed?z.object({title_translations:localizedTextSchema}).safeParse(completed):null;
      const validator=completed.validated_by_person_id?validatorMap.get(completed.validated_by_person_id):null;
      const validatorResource:Resource={...scope,type:"identity",id:validator?.id,assignedPersonId:validator?.id};
      const ownValidator=validator?.userAccounts.some(account=>account.id===ctx.actorId),validatorAllowed=Boolean(validator&&(ownValidator||can(validatorResource)));
      if(validatorAllowed&&!ownValidator)metadataChecks.push({action:"view",resource:validatorResource});
      return{lineId:row.id,personName:personAllowed?row.person.displayName:null,propertyName:propertyAllowed?row.property.name:null,
        roleName:row.compensation.assignment.role.name,contractVersion:row.compensation.version,effectiveFrom:row.compensation.effectiveFrom.toISOString(),
        sourceTitle:title?.success?title.data.title_translations:null,canViewTask:taskAllowed,completionMethod:completed.completion_source,validatorName:validatorAllowed?validator!.displayName:null,
        validatedAt:completed.validated_at};
    });
    const refreshed=await repository.find(record.id);
    if(!refreshed||JSON.stringify(refreshed)!==JSON.stringify(record)||rows.length!==model.lines.length)throw new EmployeeCompensationRunAccessError();
    await recheckEmployeeCompensationRun(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),employeeCompensationRunFacts(ctx.organizationId,refreshed));
    await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),metadataChecks,new EmployeeCompensationRunAccessError());
    const facts=employeeCompensationRunFacts(ctx.organizationId,refreshed),at=await new FinanceRepository(tx,ctx.organizationId).clock();
    const canCancel=record.cancellation===null&&[ctx.authContext,current].every(auth=>authorize(auth,"void",facts.resource,at));
    return employeeCompensationRunDetailSchema.parse({...model,labels,canCancel});
  },{timeout:120000});
}
