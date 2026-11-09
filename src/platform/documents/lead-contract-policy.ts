import type {TenantTransaction} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {leadPipelinePolicyKey,leadPipelinePolicySchema} from "@/modules/crm/domain/lead-pipeline";
import {DocumentConfigurationError} from "@/modules/documents/domain/document-command";

/** Native contract approval comes from the existing CRM policy, never a caller's type claim. */
export async function nativeLeadContractPolicy(tx:TenantTransaction,organizationId:string,typeKey:string,asOf:Date){
 const rule=await new ConfigRuleRepository(tx,organizationId).resolve({key:leadPipelinePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf}),policy=leadPipelinePolicySchema.safeParse(rule?.parsedValue);
 if(!rule?.createdBy||!policy.success||!policy.data.document_types.contract.includes(typeKey))throw new DocumentConfigurationError();
 return{id:rule.id,version:rule.version,contractTypeKeys:[...policy.data.document_types.contract]};
}
