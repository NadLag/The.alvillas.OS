import type {z} from "zod";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {authorizeOrganizationSource} from "@/platform/authz/organization-authority";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {type receivablePartyKind,receivableAssignmentPolicyKey,receivableAssignmentPolicySchema} from "../domain/receivable-assignment";
import {receivablePolicyKey,ReceivablePolicyError,ReceivableAccessError} from "../domain/receivable";
import {receivableSourcesInput,receivablePartiesInput,receivableHistoryInput,receivableEditorSchema,receivableSourcesSchema,receivablePartiesSchema,receivableHistorySchema} from "../domain/receivable-workspace";
import {ReceivableRepository} from "../infrastructure/receivable-repository";
import {ReceivableAssignmentRepository} from "../infrastructure/receivable-assignment-repository";
import {recheckReceivableAuthority} from "./receivable-access";
import {receivableAssignmentView} from "./receivable-assignment-service";
import type {FinanceActorContext} from "./finance-access";
type Deps={db?:TenantTransactionRunner;requestId?:string};
const partyResource={GUEST:"guest",OWNER:"owner",SUPPLIER:"supplier",PERSON:"team_member"} as const;
async function policies(ctx:FinanceActorContext,tx:TenantTransaction){const now=await recheckReceivableAuthority(ctx,tx),configs=new ConfigRuleRepository(tx,ctx.organizationId),scopes=[{scopeType:"organization",scopeId:null}],source=await configs.resolve({key:receivablePolicyKey,scopes,asOf:now}),assignment=await configs.resolve({key:receivableAssignmentPolicyKey,scopes,asOf:now});if(!source||!assignment)throw new ReceivablePolicyError();const config=await new ReceivableRepository(tx,ctx.organizationId).assertConfiguredAccounts(source.value),parties=receivableAssignmentPolicySchema.parse(assignment.value);return{now,config,parties,identity:source.id+":"+assignment.id};}
async function complete<T extends Record<string,unknown>>(ctx:FinanceActorContext,tx:TenantTransaction,data:T,action:string,input:Record<string,unknown>,deps:Deps,recheck?:()=>Promise<void>){
  const now=await recheckReceivableAuthority(ctx,tx);await recheck?.();const result=present({...ctx.authContext,visibleDataClasses:new Set()},"view",{type:"receivable",organizationId:ctx.organizationId,id:ctx.organizationId,dataClass:"financial",data},catalogFieldPolicy<T>("receivable"),now) as T;
  await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action,resourceType:"receivable",resourceId:ctx.organizationId,after:input,reason:"Viewed authorized original receivable source workspace",requestId:deps.requestId??crypto.randomUUID(),occurredAt:now});await recheckReceivableAuthority(ctx,tx);await recheck?.();return result;
}
async function currentPartyAuthority(ctx:FinanceActorContext,tx:TenantTransaction,kind:z.infer<typeof receivablePartyKind>){const now=await recheckReceivableAuthority(ctx,tx),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),target={type:partyResource[kind],organizationId:ctx.organizationId,dataClass:"personal" as const};if(![ctx.authContext,current].every(auth=>authorizeOrganizationSource(auth,"view",target,now)))throw new ReceivableAccessError();return now;}

export async function getReceivableEditor(ctx:FinanceActorContext,deps:Deps={}){return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const config=await policies(ctx,tx),settings=await new ReceivableRepository(tx,ctx.organizationId).settings(),current=await authContextForAccountInTransaction(tx,ctx.organizationId,ctx.actorId),allowed=(action:"create"|"edit")=>[ctx.authContext,current].every(auth=>authorizeOrganizationSource(auth,action,{type:"receivable",organizationId:ctx.organizationId,dataClass:"financial"},config.now)),kinds=config.parties.party_types.filter(kind=>[ctx.authContext,current].every(auth=>authorizeOrganizationSource(auth,"view",{type:partyResource[kind],organizationId:ctx.organizationId,dataClass:"personal"},config.now)));
  const result=receivableEditorSchema.parse({source:{currencies:settings.currencies.map(row=>row.code),baseCurrency:settings.baseCurrency,partyKinds:kinds,canCreate:allowed("create"),canRelease:allowed("edit")}});
  return complete(ctx,tx,result,"finance.receivables.editor_viewed",{},deps,async()=>{if((await policies(ctx,tx)).identity!==config.identity)throw new ReceivablePolicyError();for(const kind of kinds)await currentPartyAuthority(ctx,tx,kind);});
});}
export async function getReceivableSources(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=receivableSourcesInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  const config=await policies(ctx,tx),rows=await new ReceivableAssignmentRepository(tx,ctx.organizationId).sources(config.config.account_codes,input.currency,input.after),result=receivableSourcesSchema.parse({source:{items:rows.slice(0,25).map(row=>({id:row.id,reference:row.reference,occurredAt:row.occurredAt.toISOString(),originalAmount:Money.of(row.original,input.currency).toJSON(),unassignedAmount:Money.of(row.unassigned,input.currency).toJSON()})),next:rows.length>25?rows[24].id:null}});
  return complete(ctx,tx,result,"finance.receivables.sources_viewed",input,deps,async()=>{if((await policies(ctx,tx)).identity!==config.identity)throw new ReceivablePolicyError();});
});}
export async function getReceivableParties(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=receivablePartiesInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  await currentPartyAuthority(ctx,tx,input.kind);const config=await policies(ctx,tx);if(!config.parties.party_types.includes(input.kind))throw new ReceivablePolicyError();const repository=new ReceivableAssignmentRepository(tx,ctx.organizationId),rows=await repository.parties(input.kind,input.search,input.after),resource=partyResource[input.kind],now=await currentPartyAuthority(ctx,tx,input.kind),items=rows.slice(0,25).map(row=>present({...ctx.authContext,visibleDataClasses:new Set()},"view",{type:resource,organizationId:ctx.organizationId,id:row.id,dataClass:"personal",data:{id:row.id,name:row.displayName}},{name:{dataClass:"personal",requiredPermission:resource+":view"}},now)),result=receivablePartiesSchema.parse({source:{items,next:rows.length>25?rows[24].id:null}});
  return complete(ctx,tx,result,"finance.receivables.parties_viewed",{kind:input.kind,count:items.length},deps,async()=>{await currentPartyAuthority(ctx,tx,input.kind);if((await policies(ctx,tx)).identity!==config.identity)throw new ReceivablePolicyError();});
});}
export async function getReceivableAssignmentHistory(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){const input=receivableHistoryInput.parse(raw);return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
  await recheckReceivableAuthority(ctx,tx);const rows=await new ReceivableAssignmentRepository(tx,ctx.organizationId).history(input.after),result=receivableHistorySchema.parse({source:{items:rows.slice(0,25).map(receivableAssignmentView),next:rows.length>25?rows[24].id:null}});return complete(ctx,tx,result,"finance.receivables.assignments_viewed",input,deps);
});}
