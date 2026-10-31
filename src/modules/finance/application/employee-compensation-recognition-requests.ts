import { z,ZodError } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap,restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { EmployeeCompensationClaimRepository } from "../infrastructure/employee-compensation-claim-repository";
import { EmployeeCompensationRecognitionRequestRepository,type EmployeeRecognitionOutcomeState } from "../infrastructure/employee-compensation-recognition-request-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { employeeCompensationRecognitionInput,employeeCompensationRecognitionRequestViewSchema,EmployeeCompensationRecognitionSourceError } from "../domain/employee-compensation-recognition";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import { prepareEmployeeCompensationRecognition,recognizeEmployeeCompensation,employeeCompensationRecognitionFingerprint } from "./employee-compensation-recognition";
import { recheckEmployeeSubmission } from "./employee-compensation-submission";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import type { FinanceActorContext } from "./finance-access";

export const employeeCompensationRecognitionRequested="EmployeeCompensationRecognitionRequested";
const referenceSchema=z.object({organizationId:z.uuid(),outboxEventId:z.uuid()}).strict(),eventPayload=z.object({requestId:z.uuid()}).strict();
const key=(id:string)=>`employee-compensation-recognition-request:${id}:requested`;
type Deps={db?:TenantTransactionRunner;requestId?:string;eventType?:string};
type Request=NonNullable<Awaited<ReturnType<EmployeeCompensationRecognitionRequestRepository["find"]>>>;
const view=(request:Request,idempotent:boolean)=>employeeCompensationRecognitionRequestViewSchema.parse({requestId:request.id,submissionId:request.submissionId,claimId:request.claimId,state:request.outcome?.state??"PENDING",recognitionId:request.outcome?.recognitionId??null,failureCode:request.outcome?.failureCode??null,idempotent});
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const actorFor=(request:Request):FinanceActorContext=>{try{const authContext=restoreAuthorizationCap(request.authorizationCap);if(authContext.organizationId!==request.organizationId||authContext.userAccountId!==request.requestedBy)throw new EmployeeCompensationRunAccessError();return{organizationId:request.organizationId,actorId:request.requestedBy,authContext};}catch{throw new EmployeeCompensationRunAccessError();}};
async function reader(ctx:FinanceActorContext,request:Request,tx:TenantTransaction){
  if(request.requestedBy!==ctx.actorId)throw new EmployeeCompensationRunAccessError();const claims=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),source=await claims.find(request.submissionId);
  if(!source||!source.claims.some(claim=>claim.id===request.claimId))throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,source,tx);
}
export async function requestEmployeeCompensationRecognition(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=employeeCompensationRecognitionInput.parse(raw),fingerprint=employeeCompensationRecognitionFingerprint(ctx.actorId,input),cap=captureAuthorizationCap(ctx.authContext);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId);await repository.lockKey(input.idempotencyKey);
    const existing=await repository.byKey(input.idempotencyKey);
    if(existing){await reader(ctx,existing,tx);if(existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return view(existing,true);}
    const prepared=await prepareEmployeeCompensationRecognition(ctx,input,tx),request=await repository.create({submissionId:input.id,claimId:input.claimId,requestedBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,input:json(input),authorizationCap:cap});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.employee_compensation.recognition_requested",resourceType:"employee_compensation_claim",resourceId:input.claimId,after:{requestId:request.id},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:request.requestedAt});
    const outbox=new OutboxRepository(tx,ctx.organizationId);await outbox.append(employeeCompensationRecognitionRequested,{requestId:request.id},key(request.id),request.requestedAt);await outbox.requestDispatch(`employee-recognition:${request.id}:dispatch`);
    await repository.flushGuards();await prepared.recheck();return view({...request,outcome:null},false);
  },{timeout:120000});
}
export async function getEmployeeCompensationRecognitionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=z.object({id:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const request=await new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId).find(input.id);if(!request)throw new EmployeeCompensationRunAccessError();await reader(ctx,request,tx);return view(request,true);
  });
}
export async function recoverEmployeeCompensationRecognitionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=z.object({id:z.uuid(),claimId:z.uuid(),key:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId);await repository.lockKey(input.key);const request=await repository.byKey(input.key);
    if(request){if(request.submissionId!==input.id||request.claimId!==input.claimId)throw new EmployeeCompensationRunAccessError();await reader(ctx,request,tx);return{request:view(request,true)};}
    await prepareEmployeeCompensationRecognition(ctx,{id:input.id,claimId:input.claimId,idempotencyKey:input.key,reason:"Recover an uncertain original employee recognition request",currentPeriod:false},tx);return{request:null};
  },{timeout:120000});
}
async function fromReference(tx:TenantTransaction,reference:z.infer<typeof referenceSchema>,expected?:string){
  const event=await new OutboxRepository(tx,reference.organizationId).event(reference.outboxEventId);
  if(!event||event.type!==employeeCompensationRecognitionRequested||expected&&event.type!==expected)throw new EmployeeCompensationRunAccessError();
  const payload=eventPayload.safeParse(event.payload);if(!payload.success)throw new EmployeeCompensationRunAccessError();const repository=new EmployeeCompensationRecognitionRequestRepository(tx,reference.organizationId);await repository.lockRequest(payload.data.requestId);const request=await repository.find(payload.data.requestId);
  if(!request||event.idempotencyKey!==key(request.id)||event.occurredAt.getTime()!==request.requestedAt.getTime())throw new EmployeeCompensationRunAccessError();return{request,repository};
}
async function writeOutcome(tx:TenantTransaction,request:Request,state:EmployeeRecognitionOutcomeState,recognitionId:string|null,failureCode:string|null,traceId:string){
  const id=crypto.randomUUID(),input=employeeCompensationRecognitionInput.parse(request.input);
  await writeAuditEvent(tx,{organizationId:request.organizationId,actorId:request.requestedBy,action:"finance.employee_compensation.recognition_completed",resourceType:"employee_compensation_claim",resourceId:request.claimId,
    after:{requestId:request.id,outcomeId:id,state,recognitionId,failureCode},reason:input.reason,requestId:traceId,occurredAt:await new FinanceRepository(tx,request.organizationId).clock()});
  await new EmployeeCompensationRecognitionRequestRepository(tx,request.organizationId).outcome({id,requestId:request.id,state,recognitionId,failureCode});
}
export async function executeEmployeeCompensationRecognitionReference(raw:unknown,deps:Deps={}){
  const reference=referenceSchema.parse(raw),traceId=deps.requestId??crypto.randomUUID();
  try{return await withTenant(deps.db??prisma,reference.organizationId,async tx=>{
    const{request,repository}=await fromReference(tx,reference,deps.eventType);if(request.outcome)return view(request,true);const ctx=actorFor(request),input=employeeCompensationRecognitionInput.parse(request.input);
    const result=await recognizeEmployeeCompensation(ctx,input,{db:{$transaction:work=>work(tx)},requestId:traceId});await writeOutcome(tx,request,"SUCCEEDED",result.recognitionId,null,traceId);await repository.flushGuards();
    const prepared=await prepareEmployeeCompensationRecognition(ctx,input,tx);await prepared.recheck();const saved=await repository.find(request.id);if(!saved)throw new EmployeeCompensationRunConflictError();return view(saved,false);
  },{timeout:120000});}catch(error){
    const failure=error instanceof EmployeeCompensationRunAccessError?{state:"DENIED" as const,code:"ACCESS_DENIED"}:error instanceof EmployeeCompensationRunConflictError||error instanceof EmployeeCompensationRecognitionSourceError?{state:"CONFLICT" as const,code:"SOURCE_CHANGED"}:
      error instanceof AccountingPeriodClosedError?{state:"CONFLICT" as const,code:"PERIOD_CLOSED"}:error instanceof ExpensePolicyUnavailableError||error instanceof ZodError?{state:"CONFLICT" as const,code:"POLICY_UNAVAILABLE"}:null;
    if(!failure)throw error;return finishFailure(reference,failure.state,failure.code,{...deps,requestId:traceId});
  }
}
async function finishFailure(reference:z.infer<typeof referenceSchema>,state:Exclude<EmployeeRecognitionOutcomeState,"SUCCEEDED">,failureCode:string,deps:Deps){
  return withTenant(deps.db??prisma,reference.organizationId,async tx=>{const{request,repository}=await fromReference(tx,reference,deps.eventType);if(request.outcome)return view(request,true);await writeOutcome(tx,request,state,null,failureCode,deps.requestId??crypto.randomUUID());await repository.flushGuards();const saved=await repository.find(request.id);if(!saved)throw new EmployeeCompensationRunConflictError();return view(saved,false);});
}
export function failEmployeeCompensationRecognitionReference(raw:unknown,deps:Deps={}){return finishFailure(referenceSchema.parse(raw),"FAILED","EXECUTION_UNAVAILABLE",deps);}
