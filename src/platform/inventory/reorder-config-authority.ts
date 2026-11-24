import type {CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {financialRuleSourceChecks,protectedFinancialRuleKey} from "@/platform/config/financial-rule-authority";
import {referencedConfigs} from "@/platform/automation/rule";
/** Reuse each protected rule's registered financial sources. Native inventory
 * access never grants access to conditions or outcomes derived from those rules. */
export function inventoryReorderConfigChecks(organizationId:string,property:{id:string;cityId?:string|null;regionId?:string|null}|null,configs:unknown,rule?:unknown):CurrentAuthorityCheck[]{
 const keys=new Set([...(configs&&typeof configs==="object"&&!Array.isArray(configs)?Object.keys(configs):[]),...referencedConfigs(rule)]),checks:CurrentAuthorityCheck[]=[];
 for(const key of keys){if(protectedFinancialRuleKey(key))checks.push(...financialRuleSourceChecks(organizationId,key));else if(key==="services.pricing")checks.push({action:"view",resource:{type:"financial_transaction",organizationId,propertyId:property?.id,city:property?.cityId,region:property?.regionId,dataClass:"financial"},...property?{unconditional:true}:{organizationOnly:true}});}
 return checks;
}
