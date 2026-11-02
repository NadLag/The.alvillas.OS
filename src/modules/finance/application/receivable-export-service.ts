import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {ReceivablePolicyError} from "../domain/receivable";
import {receivableExportPolicyKey,receivableExportPolicySchema} from "../domain/receivable-export-policy";
import {receivableExportInput,receivableAgingCsv,ReceivableExportRateLimitError,type ReceivableExportLabels} from "../domain/receivable-export";
import {ReceivableAgingSourceError} from "../domain/receivable-aging";
import {recheckReceivableAuthority} from "./receivable-access";
import {getReceivableAgingForExport} from "./receivable-aging-service";
import type {FinanceActorContext} from "./finance-access";

/** Admission persists independently: a failed source read cannot reset its configured abuse budget. */
export async function exportReceivableAgingCsv(ctx:FinanceActorContext,raw:unknown,labels:ReceivableExportLabels,deps:{db?:TenantTransactionRunner;requestId?:string}={}){
 const input=receivableExportInput.parse(raw),db=deps.db??prisma;
 const admission=await withTenant(db,ctx.organizationId,async tx=>{
  const now=await recheckReceivableAuthority(ctx,tx,"export"),rule=await new ConfigRuleRepository(tx,ctx.organizationId).resolve({key:receivableExportPolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:now});
  if(!rule)throw new ReceivablePolicyError();const policy=receivableExportPolicySchema.safeParse(rule.value);if(!policy.success)throw new ReceivablePolicyError();
  const decision=await consumeRateLimit(tx,ctx.organizationId,{key:"finance.receivables.export:"+ctx.actorId,limit:policy.data.rate_limit.requests,windowSeconds:policy.data.rate_limit.window_seconds,now});return{policyId:rule.id,decision};
 });
 if(!admission.decision.allowed)throw new ReceivableExportRateLimitError(admission.decision.resetAt);
 const rendered:{file?:ReturnType<typeof receivableAgingCsv>}={};
 await getReceivableAgingForExport(ctx,input.query,{policyId:admission.policyId,reason:input.reason,prepare:source=>{rendered.file=receivableAgingCsv(source,input.locale,labels);}},{...deps,db});
 if(!rendered.file)throw new ReceivableAgingSourceError();return rendered.file;
}
