import { employeeCompensationSourceGroups } from "../domain/employee-compensation-source-identity";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { employeeCompensationSubmittedFinancialSources } from "@/platform/authz/employee-compensation-resource";
import { Money } from "@/platform/money/money";
import { ApprovalRepository } from "@/platform/approvals/approval-repository";
import { approvalResource,invoiceApprovalSourceSnapshotSchema } from "@/platform/approvals/approval";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { NotificationAudienceUnavailableError } from "@/platform/notifications/notification";
import { notificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { employeeCompensationSubmissionInput,employeeCompensationSubmissionViewSchema } from "../domain/employee-compensation-claim";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationClaimRepository,type EmployeeSubmissionRecord } from "../infrastructure/employee-compensation-claim-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRecognitionRepository } from "../infrastructure/employee-compensation-recognition-repository";
import { employeeCompensationRunFacts,recheckEmployeeCompensationRun } from "./employee-compensation-run-access";
import type { FinanceActorContext } from "./finance-access";
import { prepareEmployeeCompensationClaimPolicy } from "./employee-compensation-claim-policy";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";

export { employeeCompensationSubmissionInput } from "../domain/employee-compensation-claim";
export function employeeCompensationSubmissionFingerprint(actorId:string,input:z.infer<typeof employeeCompensationSubmissionInput>){return createHash("sha256").update(JSON.stringify({...input,actorId,costs:[...input.costs].sort((a,b)=>a.runLineId.localeCompare(b.runLineId))})).digest("hex");}
type Deps={db?:TenantTransactionRunner;requestId?:string};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
export const employeeCompensationSubmissionState=(row:EmployeeSubmissionRecord)=>row.withdrawal?"WITHDRAWN":row.approval?.state==="PENDING"?"PENDING_APPROVAL":row.approval?.state??"APPROVED";
const receipt=(row:EmployeeSubmissionRecord,idempotent:boolean)=>({id:row.id,runId:row.runId,state:employeeCompensationSubmissionState(row),approvalId:row.approval?.id??null,claimCount:row.claims.length,costCount:row.costs.length,idempotent});

/** Complete artifact authority precedes the paged DTO; no policy, request restriction or private rate dump is returned. */
export const employeeCompensationSubmissionReadInput=z.object({id:z.uuid(),after:z.uuid().optional()}).strict();
/** Shared projection of already authorized original costs; callers retain complete artifact and field authority. */
export function employeeCompensationCostRows(costs:EmployeeSubmissionRecord["costs"]){return costs.map(cost=>({id:cost.id,claimId:cost.claimId,personId:cost.claim.personId,runLineId:cost.runLineId,propertyId:cost.propertyId,reservationId:cost.reservationId,completionEventId:cost.completionEventId,
 amount:Money.of(cost.amount.toString(),cost.currency).toJSON(),category:cost.category,costCenter:cost.costCenter,note:cost.note,
 allocation:z.object({allocation:employeeCompensationSubmissionViewSchema.shape.costs.element.shape.allocation}).passthrough().parse(cost.policySnapshot).allocation}));}
export async function readEmployeeCompensationSubmissionInTransaction(ctx:FinanceActorContext,input:z.infer<typeof employeeCompensationSubmissionReadInput>,tx:TenantTransaction,deps:Deps={},selection?:{claimId:string}){
    const repository=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),row=await repository.find(input.id);if(!row)throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,row,tx);
    if(selection&&!row.claims.some(claim=>claim.id===selection.claimId))throw new EmployeeCompensationRunAccessError();
    const selected=selection?row.costs.filter(cost=>cost.claimId===selection.claimId):row.costs,boundary=input.after?selected.findIndex(cost=>cost.id===input.after):-1;if(input.after&&boundary<0)throw new EmployeeCompensationRunAccessError();const page=selected.slice(boundary+1,boundary+52);
    let canWithdraw=!row.withdrawal&&!(await new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId).forSubmission(row.id)).length;
    if(canWithdraw)try{await recheckEmployeeSubmission(ctx,row,tx,"void");}catch(error){if(error instanceof EmployeeCompensationRunAccessError)canWithdraw=false;else throw error;}
    const history:Array<{action:"SUBMITTED"|"APPROVED"|"REJECTED"|"WITHDRAWN";at:string;reason:string}>=[{action:"SUBMITTED",at:row.createdAt.toISOString(),reason:row.reason}];
    if(row.approval?.decidedAt&&row.approval.decisionReason&&(row.approval.state==="APPROVED"||row.approval.state==="REJECTED"))history.push({action:row.approval.state,at:row.approval.decidedAt.toISOString(),reason:row.approval.decisionReason});
    if(row.withdrawal)history.push({action:"WITHDRAWN",at:row.withdrawal.createdAt.toISOString(),reason:row.withdrawal.reason});
    const view=employeeCompensationSubmissionViewSchema.parse({id:row.id,runId:row.runId,state:employeeCompensationSubmissionState(row),purpose:row.run.purpose,costOn:row.costOn.toISOString().slice(0,10),createdAt:row.createdAt.toISOString(),
      total:employeeCompensationRunFacts(ctx.organizationId,row.run).total.toJSON(),claimCount:row.claims.length,costCount:row.costs.length,approvalId:row.approval?.id??null,canWithdraw,
      costs:employeeCompensationCostRows(page.slice(0,50)),nextCursor:page.length>50?page[49].id:null,history});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.viewed",resourceType:"employee_compensation_submission",resourceId:row.id,
      after:{submissionId:row.id},reason:"Viewed the authorized original employee cost proposal",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await new FinanceRepository(tx,ctx.organizationId).clock()});
    const final=await repository.find(row.id);if(JSON.stringify(final)!==JSON.stringify(row))throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,row,tx);return{model:view,record:row};
}
export async function getEmployeeCompensationSubmission(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationSubmissionReadInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>(await readEmployeeCompensationSubmissionInTransaction(ctx,input,tx,deps)).model);
}

/** Historical retries bind the frozen source and current authority, without replacing approved terms. */
export async function recheckEmployeeSubmission(ctx:FinanceActorContext,row:EmployeeSubmissionRecord,tx:TenantTransaction,action:"view"|"edit"|"void"="view"){
  const finance=new FinanceRepository(tx,ctx.organizationId),facts=employeeCompensationRunFacts(ctx.organizationId,row.run);
  await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),facts,action,employeeCompensationSubmissionFinancialChecks(ctx.organizationId,row,facts.total));
}
export function employeeCompensationSubmissionFinancialChecks(organizationId:string,row:{costOn:Date;run:{createdBy:string};costs:ReadonlyArray<{propertyId:string|null;reservationId:string|null;amount:{toString():string};timezone:string;
  runLine:{taskId:string|null;recordedCompletionAt:Date};property:{cityId:string|null;regionId:string|null}|null}>},total:Money){
  return employeeCompensationSubmittedFinancialSources(organizationId,row,total).map(resource=>({action:"view" as const,resource,organizationOnly:!resource.propertyId}));
}

export async function withdrawEmployeeCompensation(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=z.object({id:z.uuid(),reason:z.string().trim().min(6).max(500)}).strict().parse(raw);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
    const initial=await repository.find(input.id);if(!initial)throw new EmployeeCompensationRunAccessError();await runs.lock(initial.runId);await repository.lock(input.id);
    const row=await repository.find(input.id);if(!row)throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,row,tx,"void");
    if(row.withdrawal){if(row.withdrawal.withdrawnBy!==ctx.actorId||row.withdrawal.reason!==input.reason)throw new EmployeeCompensationRunConflictError();return receipt(row,true);}
    if((await new EmployeeCompensationRecognitionRepository(tx,ctx.organizationId).forSubmission(row.id)).length)throw new EmployeeCompensationRunConflictError();
    await repository.lockSources(employeeCompensationSourceGroups(row.costs.map(cost=>cost.runLine)).keys);const withdrawal=await repository.withdraw(row.id,ctx.actorId,input.reason);
    if(row.approval)await new ApprovalRepository(tx,ctx.organizationId).resolveNotifications(row.approval.id,"CANCELLED",await finance.clock());
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.withdrawn",resourceType:"employee_compensation_submission",resourceId:row.id,
      after:{submissionId:row.id,withdrawalId:withdrawal.id},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    await repository.event(row.id,"EmployeeCompensationWithdrawn");await repository.flushGuards();await recheckEmployeeSubmission(ctx,row,tx,"void");
    const saved=await repository.find(row.id);if(!saved)throw new EmployeeCompensationRunConflictError();return receipt(saved,false);
  });
}

/** Submission freezes actual work costs for configured review; it makes no ledger movement. */
export async function submitEmployeeCompensation(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationSubmissionInput.parse(raw),fingerprint=employeeCompensationSubmissionFingerprint(ctx.actorId,input);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId),finance=new FinanceRepository(tx,ctx.organizationId);
    await repository.lockKey(input.idempotencyKey);await runs.lock(input.runId);
    const existing=await repository.byKey(input.idempotencyKey);
    if(existing){await recheckEmployeeSubmission(ctx,existing,tx,"edit");if(existing.runId!==input.runId||existing.submittedBy!==ctx.actorId||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return receipt(existing,true);}
    const run=await runs.find(input.runId);if(!run||run.cancellation)throw new EmployeeCompensationRunAccessError();
    await recheckEmployeeCompensationRun(ctx,tx,await finance.clock(),employeeCompensationRunFacts(ctx.organizationId,run),"edit");
    const sources=employeeCompensationSourceGroups(run.lines);await repository.lockSources(sources.keys);
    if((await repository.activeSources(sources.completionEventIds,sources.monthly,sources.percentage)).length)throw new EmployeeCompensationRunConflictError();
    const plan=await prepareEmployeeCompensationClaimPolicy(ctx,{runId:input.runId,costOn:input.costOn,emergency:input.emergency,costs:input.costs},tx);
    const source=await repository.create({runId:run.id,submittedBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,costOn:new Date(input.costOn+"T00:00:00Z"),
      emergency:input.emergency,reason:input.reason,snapshot:json({...plan.snapshot,stages:plan.stages})});
    const claims=await repository.createClaims(source.id,plan.costs.map(cost=>cost.personId)),byPerson=new Map(claims.map(claim=>[claim.personId,claim.id]));
    await repository.createCosts(plan.costs.map(cost=>({submissionId:source.id,claimId:byPerson.get(cost.personId)!,runLineId:cost.runLineId,completionEventId:cost.completionEventId,
      propertyId:cost.propertyId,reservationId:cost.reservationId,amount:cost.amount.amount,currency:cost.amount.currency,category:cost.category,costCenter:cost.costCenter,note:cost.note,timezone:cost.timezone,policySnapshot:json(cost.policy)})));
    let saved=await repository.find(source.id);if(!saved)throw new EmployeeCompensationRunConflictError();
    const byLine=new Map(saved.costs.map(cost=>[cost.runLineId,cost]));
    if(plan.stages.length){
      const stages=plan.stages.map(stage=>{const cost=byLine.get(stage.runLineId);if(!cost)throw new EmployeeCompensationRunConflictError();return{...stage,employeeCostId:cost.id,
        sourceSnapshot:json(invoiceApprovalSourceSnapshotSchema.parse({lineId:cost.id,note:cost.note,category:cost.category,occurredOn:input.costOn,timezone:cost.timezone,createdBy:ctx.actorId}))};});
      const approvals=new ApprovalRepository(tx,ctx.organizationId),approval=await approvals.createFinancial({employeeSubmissionId:source.id,propertyId:null,requestedBy:ctx.actorId,title:run.purpose.slice(0,160),details:input.reason,stages});
      if(!approval)throw new EmployeeCompensationRunConflictError();await approvals.event("ApprovalRequested",approval.id,null);
      await new NotificationRepository(tx,ctx.organizationId).publish({kind:"approval_requested",recipientId:ctx.actorId,targetId:approval.id},`approval:${approval.id}:stage:${approval.financialStages[0].id}:requested`);
      if(!await new NotificationRepository(tx,ctx.organizationId).financialApprovalAudiencesAvailable(approval.financialStages.map(stage=>({routing:notificationRoutingSchema.parse(stage.routingSnapshot),resource:approvalResource(approval,stage.ownerId,stage),recipients:stage.recipients.map(recipient=>recipient.userAccountId)}))))throw new ExpensePolicyUnavailableError("Configured employee cost review requires its current authorized audience");
    }
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.submitted",resourceType:"employee_compensation_submission",resourceId:source.id,
      after:{submissionId:source.id,runId:run.id,claimCount:claims.length,costCount:plan.costs.length,total:plan.total},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    let noticeCount=0;const notifications=new NotificationRepository(tx,ctx.organizationId),emergencyNotices=plan.costs.flatMap(planned=>{if(!planned.postHocNotices.length)return[];const cost=byLine.get(planned.runLineId);if(!cost)throw new EmployeeCompensationRunConflictError();return[{costId:cost.id,notices:planned.postHocNotices}];});
    if(emergencyNotices.length)try{noticeCount=(await notifications.publishEmployeeCostEmergencyNotices(source.id,emergencyNotices)).count;}catch(error){if(error instanceof NotificationAudienceUnavailableError)throw new ExpensePolicyUnavailableError("Required employee owner notice is unavailable");throw error;}
    if(noticeCount)await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.emergency_owner_notified",resourceType:"employee_compensation_submission",resourceId:source.id,
      after:{submissionId:source.id,noticeCount,ownerApprovalBypassed:true},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:await finance.clock()});
    await repository.event(source.id,"EmployeeCompensationSubmitted");await plan.recheck();await repository.flushGuards();await plan.recheck();
    if(emergencyNotices.length)try{await notifications.recheckEmployeeCostEmergencyNotices(source.id,emergencyNotices);}catch(error){if(error instanceof NotificationAudienceUnavailableError)throw new ExpensePolicyUnavailableError("Required employee owner notice audience changed");throw error;}
    saved=await repository.find(source.id);if(!saved)throw new EmployeeCompensationRunConflictError();await recheckEmployeeSubmission(ctx,saved,tx,"edit");return receipt(saved,false);
  },{timeout:120000});
}
