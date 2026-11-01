import { z,ZodError } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/platform/db/client";
import { withTenant,type TenantTransaction,type TenantTransactionRunner } from "@/platform/db/tenant";
import { captureAuthorizationCap,restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { OutboxRepository } from "@/platform/events/outbox-repository";
import { EmployeeCompensationClaimRepository } from "../infrastructure/employee-compensation-claim-repository";
import { EmployeeCompensationRecognitionRequestRepository,type EmployeeRecognitionOutcomeState,type EmployeeRecognitionOperation } from "../infrastructure/employee-compensation-recognition-request-repository";
import { FinanceRepository } from "../infrastructure/finance-repository";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError } from "../domain/employee-compensation-run";
import { employeeCompensationRecognitionInput,employeeCompensationRecognitionRequestViewSchema,EmployeeCompensationRecognitionSourceError } from "../domain/employee-compensation-recognition";
import { AccountingPeriodClosedError } from "../domain/accounting-period";
import { prepareEmployeeCompensationRecognition,recognizeEmployeeCompensation,employeeCompensationRecognitionFingerprint,inspectEmployeeCompensationRecognition } from "./employee-compensation-recognition";
import {employeeCompensationCorrectionInput,employeeCompensationCorrectionRequestViewSchema} from "../domain/employee-compensation-correction";
import {prepareEmployeeCompensationCorrection,correctEmployeeCompensationClaim,employeeCompensationCorrectionFingerprint} from "./employee-compensation-correction";
import { recheckEmployeeSubmission } from "./employee-compensation-submission";
import { ExpensePolicyUnavailableError } from "./expense-submission-policy";
import type { FinanceActorContext } from "./finance-access";

export const employeeCompensationRecognitionRequested="EmployeeCompensationRecognitionRequested";
const referenceSchema=z.object({organizationId:z.uuid(),outboxEventId:z.uuid()}).strict(),eventPayload=z.object({requestId:z.uuid()}).strict();
const key=(id:string)=>`employee-compensation-recognition-request:${id}:requested`;
type Deps={db?:TenantTransactionRunner;requestId?:string;eventType?:string;expectedOperation?:EmployeeRecognitionOperation};
type Request=NonNullable<Awaited<ReturnType<EmployeeCompensationRecognitionRequestRepository["find"]>>>;
const operation=(request:Request)=>z.enum(["RECOGNIZE","REVERSE"]).parse(request.operation);
const parseInput=(kind:EmployeeRecognitionOperation,raw:unknown)=>kind==="RECOGNIZE"?employeeCompensationRecognitionInput.parse(raw):employeeCompensationCorrectionInput.parse(raw);
function view(request:Request,idempotent:boolean){const common={requestId:request.id,submissionId:request.submissionId,claimId:request.claimId,state:request.outcome?.state??"PENDING",failureCode:request.outcome?.failureCode??null,idempotent};return operation(request)==="RECOGNIZE"?employeeCompensationRecognitionRequestViewSchema.parse({...common,recognitionId:request.outcome?.recognitionId??null}):employeeCompensationCorrectionRequestViewSchema.parse({...common,originalRecognitionId:request.originalRecognitionId,correctionId:request.outcome?.correctionId??null});}
async function prepareOperation(ctx:FinanceActorContext,kind:EmployeeRecognitionOperation,raw:unknown,tx:TenantTransaction){if(kind==="RECOGNIZE")return prepareEmployeeCompensationRecognition(ctx,raw,tx);const prepared=await prepareEmployeeCompensationCorrection(ctx,raw,tx);return{recheck:async()=>{await prepared.recheckCorrection(await prepared.finance.clock());}};}
const auditAction=(kind:EmployeeRecognitionOperation,stage:"requested"|"completed")=>`finance.employee_compensation.${kind==="RECOGNIZE"?"recognition":"correction"}_${stage}`;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const actorFor=(request:Request):FinanceActorContext=>{try{const authContext=restoreAuthorizationCap(request.authorizationCap);if(authContext.organizationId!==request.organizationId||authContext.userAccountId!==request.requestedBy)throw new EmployeeCompensationRunAccessError();return{organizationId:request.organizationId,actorId:request.requestedBy,authContext};}catch{throw new EmployeeCompensationRunAccessError();}};
async function reader(ctx:FinanceActorContext,request:Request,tx:TenantTransaction){
  if(request.requestedBy!==ctx.actorId)throw new EmployeeCompensationRunAccessError();const claims=new EmployeeCompensationClaimRepository(tx,ctx.organizationId),source=await claims.find(request.submissionId);
  if(!source||!source.claims.some(claim=>claim.id===request.claimId))throw new EmployeeCompensationRunAccessError();await recheckEmployeeSubmission(ctx,source,tx);
  if(operation(request)==="REVERSE"){const original=await inspectEmployeeCompensationRecognition(ctx,request.submissionId,request.claimId,tx);if(original.existing?.id!==request.originalRecognitionId)throw new EmployeeCompensationRunAccessError();await original.recheck();}
}
async function requestOperation(ctx:FinanceActorContext,raw:unknown,kind:EmployeeRecognitionOperation,deps:Deps){
  const input=parseInput(kind,raw),fingerprint=kind==="RECOGNIZE"?employeeCompensationRecognitionFingerprint(ctx.actorId,employeeCompensationRecognitionInput.parse(input)):employeeCompensationCorrectionFingerprint(ctx.actorId,employeeCompensationCorrectionInput.parse(input)),cap=captureAuthorizationCap(ctx.authContext);
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId);await repository.lockKey(input.idempotencyKey);
    const existing=await repository.byKey(input.idempotencyKey);
    if(existing){await reader(ctx,existing,tx);if(operation(existing)!==kind||existing.requestFingerprint!==fingerprint)throw new EmployeeCompensationRunConflictError();return view(existing,true);}
    const prepared=await prepareOperation(ctx,kind,input,tx),request=await repository.create({submissionId:input.id,claimId:input.claimId,requestedBy:ctx.actorId,idempotencyKey:input.idempotencyKey,requestFingerprint:fingerprint,input:json(input),authorizationCap:cap,operation:kind,originalRecognitionId:kind==="REVERSE"?employeeCompensationCorrectionInput.parse(input).recognitionId:null});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:auditAction(kind,"requested"),resourceType:"employee_compensation_claim",resourceId:input.claimId,after:{requestId:request.id},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:request.requestedAt});
    const outbox=new OutboxRepository(tx,ctx.organizationId);await outbox.append(employeeCompensationRecognitionRequested,{requestId:request.id},key(request.id),request.requestedAt);await outbox.requestDispatch(`employee-recognition:${request.id}:dispatch`);
    await repository.flushGuards();await prepared.recheck();return view({...request,outcome:null},false);
  },{timeout:120000});
}
export async function requestEmployeeCompensationRecognition(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){return employeeCompensationRecognitionRequestViewSchema.parse(await requestOperation(ctx,raw,"RECOGNIZE",deps));}
export async function requestEmployeeCompensationCorrection(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){return employeeCompensationCorrectionRequestViewSchema.parse(await requestOperation(ctx,raw,"REVERSE",deps));}
async function getOperation(ctx:FinanceActorContext,raw:unknown,kind:EmployeeRecognitionOperation,deps:Deps){
  const input=z.object({id:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const request=await new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId).find(input.id);if(!request||operation(request)!==kind)throw new EmployeeCompensationRunAccessError();await reader(ctx,request,tx);return view(request,true);
  });
}
export async function getEmployeeCompensationRecognitionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){return employeeCompensationRecognitionRequestViewSchema.parse(await getOperation(ctx,raw,"RECOGNIZE",deps));}
export async function getEmployeeCompensationCorrectionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){return employeeCompensationCorrectionRequestViewSchema.parse(await getOperation(ctx,raw,"REVERSE",deps));}
async function recoverOperation(ctx:FinanceActorContext,raw:unknown,kind:EmployeeRecognitionOperation,deps:Deps){
  const input=z.object({id:z.uuid(),claimId:z.uuid(),key:z.uuid()}).strict().parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const repository=new EmployeeCompensationRecognitionRequestRepository(tx,ctx.organizationId);await repository.lockKey(input.key);const request=await repository.byKey(input.key);
    if(request){if(request.submissionId!==input.id||request.claimId!==input.claimId||operation(request)!==kind)throw new EmployeeCompensationRunAccessError();await reader(ctx,request,tx);return{request:view(request,true)};}
    if(kind==="RECOGNIZE")await prepareEmployeeCompensationRecognition(ctx,{id:input.id,claimId:input.claimId,idempotencyKey:input.key,reason:"Recover an uncertain original employee recognition request",currentPeriod:false},tx);
    else{const source=await inspectEmployeeCompensationRecognition(ctx,input.id,input.claimId,tx);if(!source.existing)throw new EmployeeCompensationRunAccessError();await source.recheck();}return{request:null};
  },{timeout:120000});
}
export async function recoverEmployeeCompensationRecognitionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const result=await recoverOperation(ctx,raw,"RECOGNIZE",deps);return{request:result.request?employeeCompensationRecognitionRequestViewSchema.parse(result.request):null};}
export async function recoverEmployeeCompensationCorrectionRequest(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const result=await recoverOperation(ctx,raw,"REVERSE",deps);return{request:result.request?employeeCompensationCorrectionRequestViewSchema.parse(result.request):null};}
async function fromReference(tx:TenantTransaction,reference:z.infer<typeof referenceSchema>,expected?:string,expectedOperation?:EmployeeRecognitionOperation){
  const event=await new OutboxRepository(tx,reference.organizationId).event(reference.outboxEventId);
  if(!event||event.type!==employeeCompensationRecognitionRequested||expected&&event.type!==expected)throw new EmployeeCompensationRunAccessError();
  const payload=eventPayload.safeParse(event.payload);if(!payload.success)throw new EmployeeCompensationRunAccessError();const repository=new EmployeeCompensationRecognitionRequestRepository(tx,reference.organizationId);await repository.lockRequest(payload.data.requestId);const request=await repository.find(payload.data.requestId);
  if(!request||expectedOperation&&operation(request)!==expectedOperation||event.idempotencyKey!==key(request.id)||event.occurredAt.getTime()!==request.requestedAt.getTime())throw new EmployeeCompensationRunAccessError();return{request,repository};
}
async function writeOutcome(tx:TenantTransaction,request:Request,state:EmployeeRecognitionOutcomeState,recognitionId:string|null,correctionId:string|null,failureCode:string|null,traceId:string){
  const id=crypto.randomUUID(),kind=operation(request),input=parseInput(kind,request.input),common={requestId:request.id,outcomeId:id,state,recognitionId,failureCode};
  await writeAuditEvent(tx,{organizationId:request.organizationId,actorId:request.requestedBy,action:auditAction(kind,"completed"),resourceType:"employee_compensation_claim",resourceId:request.claimId,
    after:kind==="RECOGNIZE"?common:{...common,originalRecognitionId:request.originalRecognitionId,correctionId},reason:input.reason,requestId:traceId,occurredAt:await new FinanceRepository(tx,request.organizationId).clock()});
  await new EmployeeCompensationRecognitionRequestRepository(tx,request.organizationId).outcome({id,requestId:request.id,state,recognitionId,correctionId,failureCode});
}
export async function executeEmployeeCompensationFinancialReference(raw:unknown,deps:Deps={}){
  const reference=referenceSchema.parse(raw),traceId=deps.requestId??crypto.randomUUID();
  try{return await withTenant(deps.db??prisma,reference.organizationId,async tx=>{
    const{request,repository}=await fromReference(tx,reference,deps.eventType,deps.expectedOperation);if(request.outcome)return view(request,true);const ctx=actorFor(request),kind=operation(request),input=parseInput(kind,request.input),execution={db:{$transaction:<T>(work:(tx:TenantTransaction)=>Promise<T>)=>work(tx)},requestId:traceId};
    const result=kind==="RECOGNIZE"?await recognizeEmployeeCompensation(ctx,input,execution):await correctEmployeeCompensationClaim(ctx,input,execution);await writeOutcome(tx,request,"SUCCEEDED",kind==="RECOGNIZE"?result.recognitionId:null,"correctionId" in result?result.correctionId:null,null,traceId);await repository.flushGuards();
    const prepared=await prepareOperation(ctx,kind,input,tx);await prepared.recheck();const saved=await repository.find(request.id);if(!saved)throw new EmployeeCompensationRunConflictError();return view(saved,false);
  },{timeout:120000});}catch(error){
    const failure=error instanceof EmployeeCompensationRunAccessError?{state:"DENIED" as const,code:"ACCESS_DENIED"}:error instanceof EmployeeCompensationRunConflictError||error instanceof EmployeeCompensationRecognitionSourceError?{state:"CONFLICT" as const,code:"SOURCE_CHANGED"}:
      error instanceof AccountingPeriodClosedError?{state:"CONFLICT" as const,code:"PERIOD_CLOSED"}:error instanceof ExpensePolicyUnavailableError||error instanceof ZodError?{state:"CONFLICT" as const,code:"POLICY_UNAVAILABLE"}:null;
    if(!failure)throw error;return finishFailure(reference,failure.state,failure.code,{...deps,requestId:traceId});
  }
}
async function finishFailure(reference:z.infer<typeof referenceSchema>,state:Exclude<EmployeeRecognitionOutcomeState,"SUCCEEDED">,failureCode:string,deps:Deps){
  return withTenant(deps.db??prisma,reference.organizationId,async tx=>{const{request,repository}=await fromReference(tx,reference,deps.eventType,deps.expectedOperation);if(request.outcome)return view(request,true);await writeOutcome(tx,request,state,null,null,failureCode,deps.requestId??crypto.randomUUID());await repository.flushGuards();const saved=await repository.find(request.id);if(!saved)throw new EmployeeCompensationRunConflictError();return view(saved,false);});
}
export async function executeEmployeeCompensationRecognitionReference(raw:unknown,deps:Deps={}){return employeeCompensationRecognitionRequestViewSchema.parse(await executeEmployeeCompensationFinancialReference(raw,{...deps,expectedOperation:"RECOGNIZE"}));}
export async function executeEmployeeCompensationCorrectionReference(raw:unknown,deps:Deps={}){return employeeCompensationCorrectionRequestViewSchema.parse(await executeEmployeeCompensationFinancialReference(raw,{...deps,expectedOperation:"REVERSE"}));}
export function failEmployeeCompensationFinancialReference(raw:unknown,deps:Deps={}){return finishFailure(referenceSchema.parse(raw),"FAILED","EXECUTION_UNAVAILABLE",deps);}
export async function failEmployeeCompensationRecognitionReference(raw:unknown,deps:Deps={}){return employeeCompensationRecognitionRequestViewSchema.parse(await failEmployeeCompensationFinancialReference(raw,{...deps,expectedOperation:"RECOGNIZE"}));}
export async function failEmployeeCompensationCorrectionReference(raw:unknown,deps:Deps={}){return employeeCompensationCorrectionRequestViewSchema.parse(await failEmployeeCompensationFinancialReference(raw,{...deps,expectedOperation:"REVERSE"}));}
