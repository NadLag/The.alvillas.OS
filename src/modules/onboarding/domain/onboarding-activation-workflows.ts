import {createHash} from "node:crypto";
import {workflowCatalogSchema} from "@/platform/config/workflow-policy";
import {automationRuleSchema} from "@/platform/automation/rule";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {onboardingIdSchema} from "./onboarding-primitives";
import {OnboardingConfigurationError} from "./onboarding-wizard";

/** Names, enabled state, conditions, actions and retries come from the approved original catalog. */
export function compileOnboardingWorkflows(organizationId:string,propertyId:string,raw:unknown){
 const organization=onboardingIdSchema.parse(organizationId),property=onboardingIdSchema.parse(propertyId),catalog=workflowCatalogSchema.safeParse(raw);if(!catalog.success)throw new OnboardingConfigurationError();
 return catalog.data.workflows.map(workflow=>{const rule=automationRuleSchema.safeParse({name:workflow.name,event:workflow.trigger,enabled:workflow.enabled,conditions:workflow.conditions,actions:workflow.actions,retry:workflow.retry,...workflow.idempotency_key!==undefined?{idempotency_key:workflow.idempotency_key}:{}});if(!rule.success)throw new OnboardingConfigurationError();const key="onb_"+createHash("sha256").update(JSON.stringify(["native-onboarding-canonical-workflow-v1",organization,property,workflow.key])).digest("hex").slice(0,48);return{workflowKey:workflow.key,key,rule:rule.data,fingerprint:jsonbFingerprint(rule.data)};});
}
