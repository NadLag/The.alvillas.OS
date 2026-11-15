import {z} from "zod";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {serviceAllocationPolicyKey,serviceAllocationPolicySchema} from "@/platform/config/service-allocation-policy";
import {taxRuleSchema} from "@/platform/config/rule-registry";
import {nativeServiceCatalogProviderChoices} from "@/platform/services/catalog-provider-source";
import {serviceCatalogScopeSchema} from "../domain/service-catalog-command";
import {ServiceCatalogConfigurationError,ServiceCatalogConflictError} from "../domain/service-catalog";
import {serviceCatalogSourceContext,serviceCatalogFinancialSources} from "./service-catalog-source";

type Dependencies={db?:TenantTransactionRunner;requestId:string;ipAddress:string|null};
const providerInput=z.object({scope:serviceCatalogScopeSchema,kind:z.enum(["SUPPLIER","PERSON"]),query:z.string().trim().max(100).default(""),after:z.uuid().optional()}).strict();
async function financialChoices(actor:AccountActorContext,tx:TenantTransaction,scope:z.infer<typeof serviceCatalogScopeSchema>){
 const context=await serviceCatalogSourceContext(actor,tx,scope,"configure"),selected=await Promise.all([serviceAllocationPolicyKey,"finance.tax"].map(key=>context.repository.resolveMetadata({key,scopes:context.scopes,asOf:context.now})));if(selected.some(row=>!row))throw new ServiceCatalogConfigurationError();const source=await serviceCatalogFinancialSources(actor,context,selected.map(row=>row!.id)),allocation=source.rows.find(row=>row.id===selected[0]!.id)!,tax=source.rows.find(row=>row.id===selected[1]!.id)!;
 const services=serviceAllocationPolicySchema.parse(allocation.value).services,taxes=taxRuleSchema.parse(tax.value).taxes.map(row=>({key:row.key,amount:row.amount??null,currency:row.currency??null,rateBps:row.rate_bps??null,assessment:row.service_assessment??null}));
 return{value:{allocationRule:{id:allocation.id,version:allocation.version},taxRule:{id:tax.id,version:tax.version},services,taxes},fingerprint:jsonbFingerprint({context:context.fingerprint,authority:context.authorizationFingerprint,heads:source.heads,services,taxes})};
}
export async function serviceCatalogFinancialChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const scope=z.object({scope:serviceCatalogScopeSchema}).strict().parse(raw).scope;return withTenant(deps.db??prisma,actor.organizationId,async tx=>{const before=await financialChoices(actor,tx,scope),after=await financialChoices(actor,tx,scope);if(before.fingerprint!==after.fingerprint)throw new ServiceCatalogConflictError();return after.value;});
}
export async function serviceCatalogProviderChoices(actor:AccountActorContext,raw:unknown,deps:Dependencies){
 const input=providerInput.parse(raw);return withTenant(deps.db??prisma,actor.organizationId,async tx=>{
  const context=await serviceCatalogSourceContext(actor,tx,input.scope,"configure"),before=await nativeServiceCatalogProviderChoices(actor,tx,input,context.stored,context.now),after=await serviceCatalogSourceContext(actor,tx,input.scope,"configure"),final=await nativeServiceCatalogProviderChoices(actor,tx,input,after.stored,after.now);
  if(context.fingerprint!==after.fingerprint||context.authorizationFingerprint!==after.authorizationFingerprint||before.fingerprint!==final.fingerprint)throw new ServiceCatalogConflictError();return{items:final.items,next:final.next};
 });
}
