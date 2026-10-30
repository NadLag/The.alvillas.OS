import { z,ZodError } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap,restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { EmployeeCompensationRunRepository } from "../infrastructure/employee-compensation-run-repository";
import { EmployeeCompensationSubmissionRequestRepository,type EmployeeSubmissionOutcomeState } from "../infrastructure/employee-compensation-submission-request-repository";
import { EmployeeCompensationClaimRepository } from "../infrastructure/employee-compensation-claim-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { EmployeeCompensationClaimSourceError,employeeCompensationSubmissionRequestViewSchema } from "../domain/employee-compensation-claim";
import { employeeCompensationClaimPolicyInput } from "../domain/employee-compensation-claim";
import { employeeCompensationSubmissionInput,employeeCompensationSubmissionFingerprint,submitEmployeeCompensation,recheckEmployeeSubmission } from "./employee-compensation-submission";
import { retainEmployeeClaimSourceAccess } from "./employee-compensation-claim-source-access";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import { FinancePolicyContextChangedError } from "./finance-config-service";
import { EmployeeCompensationAccessError,EmployeeCompensationSourceUnavailableError } from "../domain/employee-compensation";
import type { FinanceActorContext } from "./finance-access";

export const employeeCompensationSubmissionRequested="EmployeeCompensationSubmissionRequested";
const referenceSchema=z.object({organizationId:z.uuid(),outboxEventId:z.uuid()}).strict();
const eventPayload=z.object({requestId:z.uuid()}).strict();
const key=(id:string)=>`employee-compensation-submission-request:${id}:requested`;
type Deps={db?:TenantTransactionRunner;requestId?:string;eventType?:string};
type Request=NonNullable<Awaited<ReturnType<EmployeeCompensationSubmissionRequestRepository["find"]>>>;
const actorFor=(request:Request):FinanceActorContext=>{try{const authContext=restoreAuthorizationCap(request.authorizationCap);if(authContext.organizationId!==request.organizationId||authContext.userAccountId!==request.requestedBy)throw new EmployeeCompensationRunAccessError();return{organizationId:request.organizationId,actorId:request.requestedBy,authContext};}catch{throw new EmployeeCompensationRunAccessError();}};
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const policyInput=(input:z.infer<typeof employeeCompensationSubmissionInput>)=>employeeCompensationClaimPolicyInput.parse({runId:input.runId,costOn:input.costOn,emergency:input.emergency,costs:input.costs});
const view=(request:Request,idempotent:boolean)=>employeeCompensationSubmissionRequestViewSchema.parse({requestId:request.id,runId:request.runId,state:request.outcome?.state??"PENDING",submissionId:request.outcome?.submissionId??null,failureCode:request.outcome?.failureCode??null,idempotent});
async function checkReader(ctx:FinanceActorContext,request:Request,tx:TenantTransaction){
  if(request.requestedBy!==ctx.actorId)throw new EmployeeCompensationRunAccessError();
  const input=employeeCompensationSubmissionInput.parse(request.input),recheck=await retainEmployeeClaimSourceAccess(ctx,policyInput(input),tx,"view");await recheck();
}

/** Bounded request work persists original intent and caller restrictions; policy preparation runs in the shared worker. */
export async function requestEmployeeCompensationSubmission(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationSubmissionInput.parse(raw),fingerprint=employeeCompensationSubmissionFingerprint(ctx.actorId,input),cap=captureAuthorizationCap(ctx.authContext);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationSubmissionRequestRepository(tx,ctx.organizationId),runs=new EmployeeCompensationRunRepository(tx,ctx.organizationId);
    await repository.lockKey(input.idempotencyKey);await runs.lock(input.runId);
    const recheck=await retainEmployeeClaimSourceAccess(ctx,policyInput(input),tx),existing=await repository.byKey(input.idempotencyKey);
    if(existing){if(existing.runId!==input.runId||existing.requestedBy!==ctx.actorId||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();await recheck();return view(existing,true);}
    const request=await repository.create({runId:input.runId,requestedBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,input:json(input),authorizationCap:cap});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.submission_requested",resourceType:"employee_compensation_run",resourceId:input.runId,
      after:{requestId:request.id},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:request.requestedAt});
    const outbox=new OutboxRepository(tx,ctx.organizationId);await outbox.append(employeeCompensationSubmissionRequested,{requestId:request.id},key(request.id),request.requestedAt);
    await outbox.requestDispatch(`employee-submission:${request.id}:dispatch`);await repository.flushGuards();await recheck();return view({...request,outcome:null},false);
  });
}

export async function getEmployeeCompensationSubmissionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=z.object({id:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const request=await new EmployeeCompensationSubmissionRequestRepository(tx,ctx.organizationId).find(input.id);if(!request)throw new EmployeeCompensationRunAccessError();await checkReader(ctx,request,tx);return view(request,true);
  });
}

async function fromReference(tx:TenantTransaction,reference:z.infer<typeof referenceSchema>,expectedEventType?:string){
  const event=await new OutboxRepository(tx,reference.organizationId).event(reference.outboxEventId);
  if(!event||event.type!==employeeCompensationSubmissionRequested||expectedEventType&&event.type!==expectedEventType)throw new EmployeeCompensationRunAccessError();
  const payload=eventPayload.safeParse(event.payload);if(!payload.success)throw new EmployeeCompensationRunAccessError();
  const repository=new EmployeeCompensationSubmissionRequestRepository(tx,reference.organizationId);await repository.lockRequest(payload.data.requestId);const request=await repository.find(payload.data.requestId);
  if(!request||event.idempotencyKey!==key(request.id)||event.occurredAt.getTime()!==request.requestedAt.getTime())throw new EmployeeCompensationRunAccessError();return{request,repository};
}
async function writeOutcome(tx:TenantTransaction,request:Request,state:EmployeeSubmissionOutcomeState,submissionId:string|null,failureCode:string|null,traceId:string){
  const id=crypto.randomUUID(),input=employeeCompensationSubmissionInput.parse(request.input);
  await writeAuditEvent(tx,{organizationId:request.organizationId,actorId:request.requestedBy,action:"finance.employee_compensation.submission_completed",resourceType:"employee_compensation_run",resourceId:request.runId,
    after:{requestId:request.id,outcomeId:id,state,submissionId,failureCode},reason:input.reason,requestId:traceId,occurredAt:await new FinanceRepository(tx,request.organizationId).clock()});
  await new EmployeeCompensationSubmissionRequestRepository(tx,request.organizationId).outcome({id,requestId:request.id,state,submissionId,failureCode});
}
export async function executeEmployeeCompensationSubmissionReference(raw:unknown,deps:Deps={}){
  const reference=referenceSchema.parse(raw),db=deps.db??prisma,traceId=deps.requestId??crypto.randomUUID();
  try{return await withTenant(db,reference.organizationId,async tx=>{
    const{request,repository}=await fromReference(tx,reference,deps.eventType);if(request.outcome)return view(request,true);
    const ctx=actorFor(request),input=employeeCompensationSubmissionInput.parse(request.input);
    const result=await submitEmployeeCompensation(ctx,input,{db:{$transaction:work=>work(tx)},requestId:traceId});
    await writeOutcome(tx,request,"SUCCEEDED",result.id,null,traceId);await repository.flushGuards();
    const saved=await new EmployeeCompensationClaimRepository(tx,request.organizationId).find(result.id);if(!saved)throw new EmployeeCompensationRunConflictError();await recheckEmployeeSubmission(ctx,saved,tx,"edit");
    const final=await repository.find(request.id);if(!final)throw new EmployeeCompensationRunConflictError();return view(final,false);
  },{timeout:120000});}catch(error){
    const failure=error instanceof EmployeeCompensationRunAccessError||error instanceof EmployeeCompensationAccessError?{state:"DENIED" as const,code:"ACCESS_DENIED"}:
      error instanceof EmployeeCompensationRunConflictError||error instanceof EmployeeCompensationClaimSourceError||error instanceof EmployeeCompensationSourceUnavailableError?{state:"CONFLICT" as const,code:"SOURCE_CHANGED"}:
      error instanceof ExpensePolicyUnavailableError||error instanceof FinancePolicyContextChangedError||error instanceof ZodError?{state:"CONFLICT" as const,code:"POLICY_UNAVAILABLE"}:null;
    if(!failure)throw error;return finishFailure(reference,failure.state,failure.code,{...deps,requestId:traceId});
  }
}
async function finishFailure(reference:z.infer<typeof referenceSchema>,state:Exclude<EmployeeSubmissionOutcomeState,"SUCCEEDED">,failureCode:string,deps:Deps){
  return withTenant(deps.db??prisma,reference.organizationId,async tx=>{const{request,repository}=await fromReference(tx,reference,deps.eventType);if(request.outcome)return view(request,true);
    await writeOutcome(tx,request,state,null,failureCode,deps.requestId??crypto.randomUUID());await repository.flushGuards();const final=await repository.find(request.id);if(!final)throw new EmployeeCompensationRunConflictError();return view(final,false);});
}
export async function failEmployeeCompensationSubmissionReference(raw:unknown,deps:Deps={}){return finishFailure(referenceSchema.parse(raw),"FAILED","EXECUTION_UNAVAILABLE",deps);}
