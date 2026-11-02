import {z} from "zod";
import type {Prisma} from "@prisma/client";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {captureAuthorizationCap} from "@/platform/authz/authorization-cap";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {ReceivableAssignmentRepository} from "../infrastructure/receivable-assignment-repository";
import {ReceivableRepository} from "../infrastructure/receivable-repository";
import {LedgerCalendarRepository} from "../infrastructure/ledger-calendar-repository";
import {receivablePolicyKey,ReceivableAccessError,ReceivablePolicyError} from "../domain/receivable";
import {receivableAssignmentPolicyKey,receivableAssignmentPolicySchema,receivableAssignmentReviewInput,receivableAssignmentCreateInput,receivableAssignmentReleaseReviewInput,receivableAssignmentReleaseInput,
  receivablePostedClaim,receivableUnassignedAmount,ReceivableAssignmentSourceError,ReceivableAssignmentConflictError} from "../domain/receivable-assignment";
import type {FinanceActorContext} from "./finance-access";
import {recheckReceivableAuthority} from "./receivable-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
type Draft=z.infer<typeof receivableAssignmentReviewInput>;
type Assignment=Prisma.ReceivableAssignmentGetPayload<{include:{release:true}}>;
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
const normalize=(draft:Draft):Draft=>({...draft,amount:Money.of(draft.amount,draft.currency).toJSON().amount});
const frame=(operation:string,input:unknown)=>commandFingerprint({operation,input});
const partyId=(row:Assignment)=>row.guestId??row.ownerId??row.supplierId??row.personId;
export function receivableAssignmentView(row:Assignment){return{id:row.id,postingId:row.postingId,party:{kind:row.partyKind,id:partyId(row)},amount:Money.of(row.amount.toString(),row.currency).toJSON(),
  dueOn:row.dueOn?.toISOString().slice(0,10)??null,purpose:row.purpose,reason:row.reason,createdBy:row.createdBy,createdAt:row.createdAt.toISOString(),
  release:row.release?{id:row.release.id,reason:row.release.reason,createdBy:row.release.createdBy,createdAt:row.release.createdAt.toISOString()}:null};}
function visible<T extends Record<string,unknown>>(ctx:FinanceActorContext,data:T,now:Date){return present({...ctx.authContext,visibleDataClasses:new Set()},"view",
  {type:"receivable",organizationId:ctx.organizationId,id:ctx.organizationId,dataClass:"financial",data},catalogFieldPolicy<T>("receivable"),now) as T;}

async function prepare(ctx:FinanceActorContext,input:Draft,tx:TenantTransaction,exceptId?:string){
  const now=await recheckReceivableAuthority(ctx,tx),repository=new ReceivableAssignmentRepository(tx,ctx.organizationId),configs=new ConfigRuleRepository(tx,ctx.organizationId),scopes=[{scopeType:"organization",scopeId:null}],
    sourcePolicy=await configs.resolve({key:receivablePolicyKey,scopes,asOf:now}),assignmentPolicy=await configs.resolve({key:receivableAssignmentPolicyKey,scopes,asOf:now});
  if(!sourcePolicy||!assignmentPolicy)throw new ReceivablePolicyError();const partyPolicy=receivableAssignmentPolicySchema.safeParse(assignmentPolicy.value);
  if(!partyPolicy.success||!partyPolicy.data.party_types.includes(input.partyKind))throw new ReceivablePolicyError();
  await new ReceivableRepository(tx,ctx.organizationId).assertConfiguredAccounts(sourcePolicy.value);
  const settings=await new LedgerCalendarRepository(tx,ctx.organizationId).settings();if(!settings.currencies.some(row=>row.code===input.currency))throw new ReceivablePolicyError();
  const original=await repository.original(input.postingId),party=await repository.party(input.partyKind,input.partyId);
  if(!original?.eligible||!party)throw new ReceivableAssignmentSourceError();
  const source=receivablePostedClaim(ctx.organizationId,input.currency,sourcePolicy.value,original.source,now),assignments=await repository.activeAssignments(input.postingId,exceptId);
  let assigned=Money.zero(input.currency);for(const row of assignments){if(row.currency!==input.currency)throw new ReceivableAssignmentSourceError();assigned=assigned.add(Money.of(row.amount.toString(),row.currency));}
  const available=receivableUnassignedAmount(source.amount,assigned);if(Money.of(input.amount,input.currency).amount.gt(available.amount))throw new ReceivableAssignmentConflictError();
  const policySnapshot={schemaVersion:1,source:{id:sourcePolicy.id,version:sourcePolicy.version,value:sourcePolicy.value},assignment:{id:assignmentPolicy.id,version:assignmentPolicy.version,value:assignmentPolicy.value}},
    reviewFingerprint=commandFingerprint({input,source:original.snapshot,policies:policySnapshot,assignments:assignments.map(row=>({id:row.id,amount:Money.of(row.amount.toString(),row.currency).toJSON()}))});
  return{now,source,sourceSnapshot:original.snapshot,sourcePolicy,assignmentPolicy,policySnapshot,available,reviewFingerprint};
}

export async function reviewReceivableAssignment(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=normalize(receivableAssignmentReviewInput.parse(raw));return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    await recheckReceivableAuthority(ctx,tx,"create");const reviewed=await prepare(ctx,input,tx),recheck=async()=>{await recheckReceivableAuthority(ctx,tx,"create");if((await prepare(ctx,input,tx)).reviewFingerprint!==reviewed.reviewFingerprint)throw new ReceivableAssignmentConflictError();};
    await recheck();const data=visible(ctx,{assignment:{party:{kind:input.partyKind,id:input.partyId},amount:Money.of(input.amount,input.currency).toJSON(),dueOn:input.dueOn,purpose:input.purpose},
      source:{postingId:input.postingId,transactionId:reviewed.source.transactionId,originalAmount:reviewed.source.amount.toJSON(),unassignedAmount:reviewed.available.toJSON(),occurredAt:reviewed.sourceSnapshot.transaction.occurredAt}},reviewed.now);
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.assignment_reviewed",resourceType:"receivable",resourceId:input.postingId,
      after:{postingId:input.postingId,partyKind:input.partyKind,partyId:input.partyId,reviewFingerprint:reviewed.reviewFingerprint},reason:"Reviewed original posted claim assignment",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await recheckReceivableAuthority(ctx,tx,"create")});
    await recheck();return{...data,reviewFingerprint:reviewed.reviewFingerprint};
  });
}

async function readReceipt(ctx:FinanceActorContext,row:Assignment,tx:TenantTransaction,deps:Deps){
  const now=await recheckReceivableAuthority(ctx,tx),data=visible(ctx,{assignment:receivableAssignmentView(row)},now);
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.assignment_viewed",resourceType:"receivable",resourceId:row.id,
    after:{assignmentId:row.id},reason:"Viewed original posted claim assignment",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  await recheckReceivableAuthority(ctx,tx);return data;
}

export async function createReceivableAssignment(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const parsed=receivableAssignmentCreateInput.parse(raw),{idempotencyKey,reviewFingerprint,reason,...draft}=parsed,input=normalize(draft),requestFingerprint=frame("ASSIGN",{...input,reviewFingerprint,reason});
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    await recheckReceivableAuthority(ctx,tx);const repository=new ReceivableAssignmentRepository(tx,ctx.organizationId);await repository.lockIntent(idempotencyKey);
    const existing=await repository.byKey(idempotencyKey);if(existing){if(existing.createdBy!==ctx.actorId)throw new ReceivableAccessError();if(existing.requestFingerprint!==requestFingerprint)throw new ReceivableAssignmentConflictError();return{...await readReceipt(ctx,existing,tx,deps),idempotent:true,idempotencyKey:existing.idempotencyKey,operation:"ASSIGN" as const};}
    if(await repository.releaseByKey(idempotencyKey))throw new ReceivableAssignmentConflictError();await recheckReceivableAuthority(ctx,tx,"create");
    const initial=await repository.original(input.postingId);if(!initial)throw new ReceivableAssignmentSourceError();await repository.lockSource(input.postingId,initial.source.transaction.id);
    const reviewed=await prepare(ctx,input,tx);if(reviewed.reviewFingerprint!==reviewFingerprint)throw new ReceivableAssignmentConflictError();
    const row=await repository.create({postingId:input.postingId,partyKind:input.partyKind,guestId:input.partyKind==="GUEST"?input.partyId:null,ownerId:input.partyKind==="OWNER"?input.partyId:null,
      supplierId:input.partyKind==="SUPPLIER"?input.partyId:null,personId:input.partyKind==="PERSON"?input.partyId:null,amount:input.amount,currency:input.currency,dueOn:input.dueOn?new Date(input.dueOn+"T00:00:00.000Z"):null,
      purpose:input.purpose,reason,idempotencyKey,requestFingerprint,reviewFingerprint,sourcePolicyRuleId:reviewed.sourcePolicy.id,assignmentPolicyRuleId:reviewed.assignmentPolicy.id,
      sourceSnapshot:json(reviewed.sourceSnapshot),policySnapshot:json(reviewed.policySnapshot),authorizationCap:json(captureAuthorizationCap(ctx.authContext)),createdBy:ctx.actorId});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.assigned",resourceType:"receivable",resourceId:row.id,
      after:{assignmentId:row.id,postingId:row.postingId,partyKind:row.partyKind,partyId:partyId(row)},reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:row.createdAt});
    const outbox=new OutboxRepository(tx,ctx.organizationId);await outbox.append("ReceivableAssigned",{assignmentId:row.id},"receivable-assignment:"+row.id+":assigned",row.createdAt);await outbox.requestDispatch("receivable-assignment:"+row.id+":dispatch");
    await repository.flushGuards();await recheckReceivableAuthority(ctx,tx,"create");if((await prepare(ctx,input,tx,row.id)).reviewFingerprint!==reviewFingerprint)throw new ReceivableAssignmentConflictError();
    const data=visible(ctx,{assignment:receivableAssignmentView(row)},await recheckReceivableAuthority(ctx,tx));await recheckReceivableAuthority(ctx,tx,"create");return{...data,idempotent:false,idempotencyKey:row.idempotencyKey,operation:"ASSIGN" as const};
  });
}

export async function getReceivableAssignment(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=receivableAssignmentReleaseReviewInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{await recheckReceivableAuthority(ctx,tx);const row=await new ReceivableAssignmentRepository(tx,ctx.organizationId).get(input.id);if(!row)throw new ReceivableAssignmentSourceError();return readReceipt(ctx,row,tx,deps);});
}

async function releaseSource(ctx:FinanceActorContext,id:string,tx:TenantTransaction){
  const now=await recheckReceivableAuthority(ctx,tx,"edit"),repository=new ReceivableAssignmentRepository(tx,ctx.organizationId),row=await repository.get(id);
  if(!row)throw new ReceivableAssignmentSourceError();if(row.release)throw new ReceivableAssignmentConflictError();const original=await repository.original(row.postingId);if(!original)throw new ReceivableAssignmentSourceError();
  return{now,row,original,reviewFingerprint:commandFingerprint({operation:"RELEASE",assignment:receivableAssignmentView(row),originalSource:original.snapshot})};
}

export async function reviewReceivableAssignmentRelease(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=receivableAssignmentReleaseReviewInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{const source=await releaseSource(ctx,input.id,tx),data=visible(ctx,{assignment:receivableAssignmentView(source.row)},source.now);
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.assignment_release_reviewed",resourceType:"receivable",resourceId:input.id,
      after:{assignmentId:input.id,reviewFingerprint:source.reviewFingerprint},reason:"Reviewed original assignment release without changing posted movements",requestId:deps.requestId??crypto.randomUUID(),occurredAt:source.now});
    if((await releaseSource(ctx,input.id,tx)).reviewFingerprint!==source.reviewFingerprint)throw new ReceivableAssignmentConflictError();return{...data,reviewFingerprint:source.reviewFingerprint};});
}

export async function releaseReceivableAssignment(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=receivableAssignmentReleaseInput.parse(raw),requestFingerprint=frame("RELEASE",{id:input.id,reviewFingerprint:input.reviewFingerprint,reason:input.reason});
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{await recheckReceivableAuthority(ctx,tx);const repository=new ReceivableAssignmentRepository(tx,ctx.organizationId);await repository.lockIntent(input.idempotencyKey);
    const existing=await repository.releaseByKey(input.idempotencyKey);if(existing){if(existing.createdBy!==ctx.actorId)throw new ReceivableAccessError();if(existing.requestFingerprint!==requestFingerprint)throw new ReceivableAssignmentConflictError();return{...await readReceipt(ctx,existing.assignment,tx,deps),idempotent:true,idempotencyKey:existing.idempotencyKey,operation:"RELEASE" as const};}
    if(await repository.byKey(input.idempotencyKey))throw new ReceivableAssignmentConflictError();const initial=await releaseSource(ctx,input.id,tx);await repository.lockSource(initial.row.postingId,initial.original.source.transaction.id);
    const source=await releaseSource(ctx,input.id,tx);if(source.reviewFingerprint!==input.reviewFingerprint)throw new ReceivableAssignmentConflictError();
    const release=await repository.release({assignmentId:input.id,idempotencyKey:input.idempotencyKey,requestFingerprint,reviewFingerprint:input.reviewFingerprint,reason:input.reason,createdBy:ctx.actorId});
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.assignment_released",resourceType:"receivable",resourceId:release.id,
      after:{assignmentId:input.id,releaseId:release.id},reason:input.reason,requestId:deps.requestId??crypto.randomUUID(),occurredAt:release.createdAt});
    const outbox=new OutboxRepository(tx,ctx.organizationId);await outbox.append("ReceivableAssignmentReleased",{assignmentId:input.id,releaseId:release.id},"receivable-assignment:"+release.id+":released",release.createdAt);await outbox.requestDispatch("receivable-assignment:"+release.id+":dispatch");
    await repository.flushGuards();await recheckReceivableAuthority(ctx,tx,"edit");const original=await repository.original(source.row.postingId);if(!original||commandFingerprint(original.snapshot)!==commandFingerprint(source.original.snapshot))throw new ReceivableAssignmentConflictError();
    const row=await repository.get(input.id);if(row?.release?.id!==release.id)throw new ReceivableAssignmentConflictError();const data=visible(ctx,{assignment:receivableAssignmentView(row)},await recheckReceivableAuthority(ctx,tx));await recheckReceivableAuthority(ctx,tx,"edit");return{...data,idempotent:false,idempotencyKey:release.idempotencyKey,operation:"RELEASE" as const};});
}

export async function recoverReceivableAssignment(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=z.object({key:z.uuid().transform(value=>value.toLowerCase())}).strict().parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{await recheckReceivableAuthority(ctx,tx);const repository=new ReceivableAssignmentRepository(tx,ctx.organizationId),created=await repository.byKey(input.key),released=created?null:await repository.releaseByKey(input.key),row=created??released?.assignment;
    if(!row){await recheckReceivableAuthority(ctx,tx);return{assignment:null};}if((created?.createdBy??released?.createdBy)!==ctx.actorId)throw new ReceivableAccessError();return{...await readReceipt(ctx,row,tx,deps),idempotent:true,idempotencyKey:created?.idempotencyKey??released!.idempotencyKey,operation:created?"ASSIGN" as const:"RELEASE" as const};});
}
