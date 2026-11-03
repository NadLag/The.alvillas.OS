import {authorize,type Action,type AuthContext,type Resource} from "./authorize";
import {authorizeOrganizationSource,authorizeUnconditionalSource} from "./organization-authority";
import type {CurrentAuthorityCheck} from "./current-authority";
import {financialRuleSourceChecks,serviceAllocationPolicyKey} from "@/platform/config/financial-rule-authority";

/** Actual allocation records combine ownership, private provider costs and their independent party sources. */
export function serviceAllocationAuthorityChecks(target:Resource,action:Action="view"):CurrentAuthorityCheck[]{
 return[{action,resource:{...target,type:"service_allocation",dataClass:"financial"},unconditional:action==="view"||action==="export"},
  ...action!=="view"&&action!=="export"?[{action:"view"as const,resource:{...target,type:"service_allocation",dataClass:"financial"as const},unconditional:true}]:[],
  ...financialRuleSourceChecks(target.organizationId,serviceAllocationPolicyKey,action==="export"?"export":"view"),
  ...["owner","supplier","team_member"].map(type=>({action:"view"as const,resource:{type,organizationId:target.organizationId,dataClass:"personal"as const},organizationOnly:true}))];
}
export function canViewServiceAllocation(auth:AuthContext,target:Resource,now:Date,action:"view"|"export"="view"){
 return target.type==="service_allocation"&&target.organizationId===auth.organizationId&&serviceAllocationAuthorityChecks(target,action).every(check=>(check.organizationOnly?authorizeOrganizationSource:check.unconditional?authorizeUnconditionalSource:authorize)(auth,check.action,check.resource,now));
}
