import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { employeeCompensationRunDetailSchema } from "../domain/employee-compensation-workspace";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { employeeCompensationRunReadInput,readEmployeeCompensationRunInTransaction } from "./employee-compensation-run-service";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";
import { employeeCompensationSourceLabels } from "./employee-compensation-source-labels";

/** Human source labels remain independently protected from salary and run access. */
export async function getEmployeeCompensationRunDetail(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=employeeCompensationRunReadInput.parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const {model,record}=await readEmployeeCompensationRunInTransaction(ctx,input,tx,deps),repository=new EmployeeCompensationRunRepository(tx,ctx.organizationId);
    const rows=await repository.displayLines(record.id,model.lines.map(line=>line.id));
    const evidence=new Map(rows.filter(row=>row.completionEvent!==null).map(row=>[row.id,employeeCompletedWorkEvidence(row.completionEvent!)]));
    const validators=await repository.people([...evidence.values()].flatMap(value=>value.validated_by_person_id?[value.validated_by_person_id]:[]));
    const {labels,checks:metadataChecks,current}=await employeeCompensationSourceLabels(ctx,tx,rows,validators);
    const refreshed=await repository.find(record.id);
    if(!refreshed||JSON.stringify(refreshed)!==JSON.stringify(record)||rows.length!==model.lines.length)throw new EmployeeCompensationRunAccessError();
    await recheckEmployeeCompensationRun(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),employeeCompensationRunFacts(ctx.organizationId,refreshed));
    await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),metadataChecks,new EmployeeCompensationRunAccessError());
    const facts=employeeCompensationRunFacts(ctx.organizationId,refreshed),at=await new FinanceRepository(tx,ctx.organizationId).clock();
    const canCancel=record.cancellation===null&&!await repository.activeSubmissions(record.id)&&[ctx.authContext,current].every(auth=>authorize(auth,"void",facts.resource,at));
    return employeeCompensationRunDetailSchema.parse({...model,labels,canCancel});
  },{timeout:120000});
}
