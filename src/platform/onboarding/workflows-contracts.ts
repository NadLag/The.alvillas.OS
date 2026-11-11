import {z} from "zod";
import {workflowCatalogSchema,workflowCatalogMaximumItems} from "@/platform/config/workflow-policy";
import {reservationTaskConfigSchema,checklistCatalogSchema} from "@/platform/config/rule-registry";
import {automationActionSchema,ruleConditionSchema,boundedJson} from "@/platform/automation/rule";

export const onboardingWorkflowsCanonicalValuesSchema=z.object({"ops.workflows":workflowCatalogSchema.nullable(),"ops.reservation_task_templates":reservationTaskConfigSchema.nullable(),"ops.checklists":checklistCatalogSchema.nullable()}).strict();
export type OnboardingWorkflowsRuleValues=z.infer<typeof onboardingWorkflowsCanonicalValuesSchema>;
export const canonicalOnboardingWorkflowsRuleValues=(raw:unknown)=>JSON.parse(JSON.stringify(onboardingWorkflowsCanonicalValuesSchema.parse(raw)))as OnboardingWorkflowsRuleValues;
const workflow=workflowCatalogSchema.shape.workflows.element;
const workflowProjection=z.object({key:workflow.shape.key,version:workflow.shape.version.unwrap().nullable(),trigger:workflow.shape.trigger,conditions:ruleConditionSchema.nullable(),actions:z.array(z.object({type:workflow.shape.actions.element.shape.type,definition:automationActionSchema.nullable()}).strict()).min(1),idempotency_key:workflow.shape.idempotency_key.unwrap().nullable()}).strict();
export const onboardingWorkflowsSettingsSchema=z.object({"ops.workflows":z.object({workflows:z.array(workflowProjection).max(workflowCatalogMaximumItems)}).strict().nullable(),"ops.reservation_task_templates":reservationTaskConfigSchema.nullable(),"ops.checklists":checklistCatalogSchema.nullable()}).strict();
/** Complete extensions remain in the encrypted original. Registered operational fields retain exact optional semantics. */
export function projectOnboardingWorkflowsSettings(raw:unknown){
 if(!boundedJson(raw,0,{remaining:200000}))throw Error("native_onboarding_workflow_source_bounds_required");
 const values=canonicalOnboardingWorkflowsRuleValues(raw),catalog=values["ops.workflows"];
 const result=onboardingWorkflowsSettingsSchema.parse({"ops.workflows":catalog===null?null:{workflows:catalog.workflows.map(row=>{
  const conditions=ruleConditionSchema.safeParse(row.conditions);return{key:row.key,version:row.version??null,trigger:row.trigger,conditions:conditions.success?conditions.data:null,actions:row.actions.map(action=>{const definition=automationActionSchema.safeParse(action);return{type:action.type,definition:definition.success?definition.data:null};}),idempotency_key:row.idempotency_key??null};
 })},"ops.reservation_task_templates":values["ops.reservation_task_templates"],"ops.checklists":values["ops.checklists"]});
 return JSON.parse(JSON.stringify(result))as typeof result;
}
export const onboardingWorkflowsTemplateValuesSchema=z.object({rules:z.object({"ops.workflows":workflowCatalogSchema.optional(),"ops.reservation_task_templates":reservationTaskConfigSchema.optional()}).strict().refine(value=>value["ops.workflows"]!==undefined||value["ops.reservation_task_templates"]!==undefined)}).strict();
