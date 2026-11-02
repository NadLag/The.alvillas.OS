import {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {authorize} from "@/platform/authz/authorize";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {encryptSecret,decryptSecret} from "@/platform/auth/secret-encryption";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {Money} from "@/platform/money/money";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {FinanceRepository,type FinanceLedgerAccount} from "../infrastructure/finance-repository";
import {ReceivableRepository} from "../infrastructure/receivable-repository";
import {ReceivableAssignmentRepository} from "../infrastructure/receivable-assignment-repository";
import {ReceivableCollectionRepository} from "../infrastructure/receivable-collection-repository";
import {receivablePolicyKey,ReceivablePolicyError,ReceivableAccessError} from "../domain/receivable";
import {receivablePostedClaim} from "../domain/receivable-assignment";
import {ReceivableCollectionSourceError,ReceivableCollectionConflictError,receivableCollectionOutstanding} from "../domain/receivable-collection";
import {receivableCollectionPolicyKey,receivableCollectionPolicySchema} from "../domain/receivable-collection-policy";
import {receivableCollectionEditorInput,receivableCollectionEditorSchema,receivableCollectionHistoryInput,receivableCollectionHistorySchema} from "../domain/receivable-collection-workspace";
import {isExpenseFundingAccount} from "../domain/expense";
import {receivableAssignmentView} from "./receivable-assignment-service";
import {receivableCollectionView,resolveSourceScope,resolveSourceScopes,receivableCollectionRetainedSource,receivableCollectionReadChecks} from "./receivable-collection-service";
import {recheckReceivableAuthority} from "./receivable-access";
import {employeeSettlementFundingChecks} from "./employee-compensation-settlement";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
const cursorSchema=z.object({purpose:z.literal("receivable.collection.accounts.v1"),organizationId:z.uuid(),actorId:z.uuid(),assignmentId:z.uuid(),source:z.string().regex(/^[a-f0-9]{64}$/u),search:z.string().max(120),after:z.uuid()}).strict();
const historyCursorSchema=z.object({purpose:z.literal("receivable.collection.history.v1"),organizationId:z.uuid(),actorId:z.uuid(),assignmentId:z.uuid().nullable(),after:z.uuid()}).strict();
async function facts(ctx:FinanceActorContext,id:string,tx:TenantTransaction){
 const now=await recheckReceivableAuthority(ctx,tx),assignments=new ReceivableAssignmentRepository(tx,ctx.organizationId),assignment=await assignments.get(id);
 if(!assignment||assignment.release)throw new ReceivableCollectionSourceError();
 const configs=new ConfigRuleRepository(tx,ctx.organizationId),scopes=[{scopeType:"organization",scopeId:null}],sourcePolicy=await configs.resolve({key:receivablePolicyKey,scopes,asOf:now}),collectionPolicy=await configs.resolve({key:receivableCollectionPolicyKey,scopes,asOf:now});
 if(!sourcePolicy||!collectionPolicy)throw new ReceivablePolicyError();const parsed=receivableCollectionPolicySchema.safeParse(collectionPolicy.value);if(!parsed.success)throw new ReceivablePolicyError();
 await new ReceivableRepository(tx,ctx.organizationId).assertConfiguredAccounts(sourcePolicy.value);const original=await assignments.original(assignment.postingId);if(!original||!original.eligible)throw new ReceivableCollectionSourceError();receivablePostedClaim(ctx.organizationId,assignment.currency,sourcePolicy.value,original.source,now);
 const movements=await new ReceivableCollectionRepository(tx,ctx.organizationId).movements(id,assignment.currency),outstanding=receivableCollectionOutstanding(Money.of(assignment.amount.toString(),assignment.currency),Money.of(movements.collected,assignment.currency)),scope=await resolveSourceScope(ctx,tx,original.snapshot.posting.dimensions),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),authorities=[ctx.authContext,current],target={...scope,organizationId:ctx.organizationId,dataClass:"financial" as const,amount:"0.00",occurredAt:now},
  canCollect=outstanding.amount.gt(0)&&authorities.every(authority=>authorize(authority,"pay",{...target,type:"receivable",id,financialRecordId:id},now)&&authorize(authority,"pay",{...target,type:"financial_transaction"},now)&&authorize(authority,"create",{...target,type:"financial_transaction"},now));
 return{now,assignment,policy:parsed.data,outstanding,authorities,canCollect,binding:commandFingerprint({assignmentId:id,sourcePolicy:sourcePolicy.id,collectionPolicy:collectionPolicy.id}),consistency:commandFingerprint({assignment:receivableAssignmentView(assignment),original:original.snapshot,sourcePolicy:sourcePolicy.id,collectionPolicy:collectionPolicy.id,movements})};
}
function visible<T extends Record<string,unknown>>(ctx:FinanceActorContext,data:T,now:Date){return present({...ctx.authContext,visibleDataClasses:new Set()},"view",{type:"receivable",organizationId:ctx.organizationId,id:ctx.organizationId,dataClass:"financial",data},catalogFieldPolicy<T>("receivable"),now)as T;}
export async function getReceivableCollectionEditor(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=receivableCollectionEditorInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const source=await facts(ctx,input.assignmentId,tx);let after:string|undefined;
  if(input.after){try{const cursor=cursorSchema.parse(JSON.parse(decryptSecret(input.after)));if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.assignmentId!==input.assignmentId||cursor.source!==source.binding||cursor.search!==input.search)throw new ReceivableAccessError();after=cursor.after;}catch{throw new ReceivableAccessError();}}
  const finance=new FinanceRepository(tx,ctx.organizationId),rows=await finance.paymentAccountChoicePage({after,query:input.search,codes:source.policy.destination_account_codes,expense:true,take:51}),checksFor=(account:FinanceLedgerAccount)=>employeeSettlementFundingChecks(ctx,account,"0.00",source.now,"view"),accounts=rows.slice(0,50).filter(account=>isExpenseFundingAccount(account)&&source.authorities.every(authority=>checksFor(account).every(check=>authorize(authority,check.action,check.resource,source.now)))),
   next=rows.length>50?encryptSecret(JSON.stringify({purpose:"receivable.collection.accounts.v1",organizationId:ctx.organizationId,actorId:ctx.actorId,assignmentId:input.assignmentId,source:source.binding,search:input.search,after:rows[49].id})):null,result=visible(ctx,receivableCollectionEditorSchema.parse({source:{assignment:receivableAssignmentView(source.assignment),outstandingAmount:source.outstanding.toJSON(),methods:source.policy.payment_methods,accounts:accounts.map(({id,name,code})=>({id,name,code})),next,canCollect:source.canCollect}}),source.now);
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.collection_editor_viewed",resourceType:"receivable",resourceId:input.assignmentId,after:{assignmentId:input.assignmentId,accountCount:accounts.length},reason:"Viewed independently authorized actual receipt choices",requestId:deps.requestId??crypto.randomUUID(),occurredAt:source.now});
  const fresh=await facts(ctx,input.assignmentId,tx);if(fresh.consistency!==source.consistency||fresh.canCollect!==source.canCollect)throw new ReceivableCollectionConflictError();await recheckFinanceAuthorization(ctx,tx,fresh.now,accounts.flatMap(checksFor),new ReceivableAccessError());return result;
 });
}
export async function getReceivableCollectionHistory(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
 const input=receivableCollectionHistoryInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const now=await recheckReceivableAuthority(ctx,tx);let after:string|undefined;
  if(input.after){try{const cursor=historyCursorSchema.parse(JSON.parse(decryptSecret(input.after)));if(cursor.organizationId!==ctx.organizationId||cursor.actorId!==ctx.actorId||cursor.assignmentId!==(input.assignmentId??null))throw new ReceivableAccessError();after=cursor.after;}catch{throw new ReceivableAccessError();}}
  const rows=await new ReceivableCollectionRepository(tx,ctx.organizationId).history(after,input.assignmentId),page=rows.slice(0,50),scopes=await resolveSourceScopes(ctx,tx,page.map(row=>receivableCollectionRetainedSource(row).posting.dimensions)),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),authorities=[ctx.authContext,current],allowed=page.filter((row,index)=>authorities.every(authority=>receivableCollectionReadChecks(ctx,row,scopes[index]).every(check=>authorize(authority,check.action,check.resource,now)))),items=allowed.slice(0,25),
   nextAfter=allowed.length>25?items[24].id:rows.length>50?rows[49].id:null,next=nextAfter?encryptSecret(JSON.stringify({purpose:"receivable.collection.history.v1",organizationId:ctx.organizationId,actorId:ctx.actorId,assignmentId:input.assignmentId??null,after:nextAfter})):null,result=visible(ctx,receivableCollectionHistorySchema.parse({source:{items:items.map(receivableCollectionView),next}}),now);
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.collections_viewed",resourceType:"receivable",resourceId:input.assignmentId??ctx.organizationId,after:{assignmentId:input.assignmentId??null,count:items.length},reason:"Viewed independently authorized immutable receivable receipts and corrections",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});
  const finalNow=await recheckReceivableAuthority(ctx,tx),finalScopes=await resolveSourceScopes(ctx,tx,items.map(row=>receivableCollectionRetainedSource(row).posting.dimensions));await recheckFinanceAuthorization(ctx,tx,finalNow,items.flatMap((row,index)=>receivableCollectionReadChecks(ctx,row,finalScopes[index])),new ReceivableAccessError());return result;
 });
}
