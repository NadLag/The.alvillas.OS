import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransactionRunner } from "@/platform/db/tenant";
import { authorize } from "@/platform/authz/authorize";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { approvalResource } from "@/platform/approvals/approval";
import { EmployeeCompensationClaimRepository } from "../infrastructure/employee-compensation-claim-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError } from "../domain/employee-compensation-run";
import { employeeCompletedWorkEvidence } from "../domain/employee-completed-work";
import { employeeCompensationCostDetailSchema } from "../domain/employee-compensation-cost-workspace";
import { employeeCompensationSubmissionReadInput,readEmployeeCompensationSubmissionInTransaction,recheckEmployeeSubmission } from "./employee-compensation-submission";
import { employeeCompensationSourceLabels } from "./employee-compensation-source-labels";
import { recheckFinanceAuthorization,type FinanceActorContext } from "./finance-access";

export async function getEmployeeCompensationCostDetail(ctx:FinanceActorContext,raw:unknown,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
  const input=employeeCompensationSubmissionReadInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const{model,record}=await readEmployeeCompensationSubmissionInTransaction(ctx,input,tx,deps),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId);
    const rows=await runs.displayLines(record.runId,model.costs.map(cost=>cost.runLineId)),evidence=rows.map(row=>employeeCompletedWorkEvidence(row.completionEvent));
    const validators=await runs.people(evidence.flatMap(event=>event.validated_by_person_id?[event.validated_by_person_id]:[])),metadata=await employeeCompensationSourceLabels(ctx,tx,rows,validators);
    if(rows.length!==model.costs.length)throw new EmployeeCompensationRunAccessError();
    const approval=record.approval?await new ApprovalRepository(tx,ctx.organizationId).find(record.approval.id):null,now=await new FinanceRepository(tx,ctx.organizationId).clock();
    const visibleStage=approval?.financialStages.find(stage=>stage.recipients.some(recipient=>recipient.userAccountId===ctx.actorId)&&[ctx.authContext,metadata.current].every(auth=>authorize(auth,"view",approvalResource(approval,stage.ownerId,stage),now)));
    const checks=[...metadata.checks,...(approval&&visibleStage?[{action:"view" as const,resource:approvalResource(approval,visibleStage.ownerId,visibleStage)}]:[])];
    const refreshed=await new EmployeeCompensationClaimRepository(tx,ctx.organizationId).find(record.id);if(JSON.stringify(refreshed)!==JSON.stringify(record))throw new EmployeeCompensationRunAccessError();
    await recheckEmployeeSubmission(ctx,record,tx);await recheckFinanceAuthorization(ctx,tx,await new FinanceRepository(tx,ctx.organizationId).clock(),checks,new EmployeeCompensationRunAccessError());
    const sourceCosts=new Map(record.costs.map(cost=>[cost.id,cost]));
    return employeeCompensationCostDetailSchema.parse({...model,labels:metadata.labels,canOpenApproval:Boolean(visibleStage),costs:model.costs.map(cost=>{const source=sourceCosts.get(cost.id)!;return{...cost,recordedCompletionAt:source.runLine.recordedCompletionAt.toISOString(),timezone:source.timezone};})});
  });
}
