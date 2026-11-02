import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {present,catalogFieldPolicy} from "@/platform/authz/present";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {receivableAccountBalances,receivableSummaryInput,receivablePolicyKey,ReceivableAccessError,ReceivablePolicyError} from "../domain/receivable";
import {ReceivableRepository} from "../infrastructure/receivable-repository";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";

type Deps={db?:TenantTransactionRunner;requestId?:string};
const target=(organizationId:string)=>({type:"receivable",id:organizationId,organizationId,dataClass:"financial" as const});
async function authority(ctx:FinanceActorContext,tx:TenantTransaction){
  const now=await new FinanceRepository(tx,ctx.organizationId).clock();
  // This complete organization aggregate includes salary-funded claims. Narrow source reads have their own authority.
  await recheckFinanceAuthorization(ctx,tx,now,["receivable","financial_transaction","staff_compensation"].map(type=>({action:"view" as const,
    resource:{...target(ctx.organizationId),type},organizationOnly:true})),new ReceivableAccessError());
  return now;
}

export async function getReceivableSummary(ctx:FinanceActorContext,raw:unknown,deps:Deps={}){
  const input=receivableSummaryInput.parse(raw);
  if(ctx.organizationId!==ctx.authContext.organizationId||ctx.actorId!==ctx.authContext.userAccountId)throw new ReceivableAccessError();
  return withTenant(deps.db??prisma,ctx.organizationId,async tx=>{
    const now=await authority(ctx,tx),repository=new ReceivableRepository(tx,ctx.organizationId),configs=new ConfigRuleRepository(tx,ctx.organizationId),scopes=[{scopeType:"organization",scopeId:null}],
      rule=await configs.resolve({key:receivablePolicyKey,scopes,asOf:now});
    if(!rule)throw new ReceivablePolicyError();
    const policyIdentity={id:rule.id,version:rule.version};
    const settings=await repository.settings();if(!settings.currencies.some(row=>row.code===input.currency))throw new ReceivablePolicyError();
    const range=await repository.range(input.fromOn,input.toOn,input.timezone),data=receivableAccountBalances(await repository.accountTotals(rule.parsedValue,{...range,currency:input.currency}),input.currency);
    async function recheck(){const at=await authority(ctx,tx),current=await configs.resolve({key:receivablePolicyKey,scopes,asOf:at});if(current?.id!==policyIdentity.id||current.version!==policyIdentity.version)throw new ReceivablePolicyError();return at;}
    await recheck();
    const visible=present({...ctx.authContext,visibleDataClasses:new Set()},"view",{...target(ctx.organizationId),data},catalogFieldPolicy<typeof data>("receivable"),now) as typeof data;
    await writeAuditEvent(tx,{organizationId:ctx.organizationId,actorId:ctx.actorId,action:"finance.receivables.viewed",resourceType:"receivable",resourceId:ctx.organizationId,
      after:{...input,configRuleId:rule.id,configVersion:rule.version,accountCount:visible.accounts.length},reason:"Viewed original movement-derived ownership claims",requestId:deps.requestId??crypto.randomUUID(),occurredAt:await recheck()});
    await recheck();
    return{...visible,fromOn:input.fromOn,toOn:input.toOn,timezone:input.timezone,configRuleId:rule.id,configVersion:rule.version,snapshotAt:now.toISOString()};
  });
}
