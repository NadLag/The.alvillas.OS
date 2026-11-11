import {z} from "zod";
import {onboardingTemplatePathSegments} from "@/platform/onboarding/template-contracts";
import {reservationTaskTemplateSchema,taskChecklistTemplateSchema} from "@/platform/config/rule-registry";
import {automationActionSchema,ruleConditionSchema,boundedJson} from "@/platform/automation/rule";
import {onboardingIdSchema,onboardingCommandFields} from "./onboarding-contract";

export const onboardingWorkflowsRuleKeys=["ops.workflows","ops.reservation_task_templates"]as const;
export const onboardingWorkflowsSourceRuleKeys=[...onboardingWorkflowsRuleKeys,"ops.checklists"]as const;
/** Pointer syntax and collection identity come from the sole canonical template implementation. */
const jsonOverride=z.unknown().refine(value=>boundedJson(value,0,{remaining:20000})).pipe(z.json());
const pathValue=z.unknown().refine(value=>ruleConditionSchema.safeParse({path:value,op:"exists"}).success);
const operandValue=z.unknown().refine(value=>ruleConditionSchema.safeParse({path:"condition.value",op:"=",value}).success);
export const onboardingWorkflowsOverridesSchema=z.record(z.string().min(1).max(600),jsonOverride).refine(values=>Object.keys(values).length<=500).superRefine((values,context)=>{
 for(const[path,value]of Object.entries(values))try{
  const segments=onboardingTemplatePathSegments(path);
  if(segments.length<5||segments[0]!=="rules"||!segments[3].startsWith("@key:"))throw Error("native_onboarding_workflow_path_required");
  if(segments[1]==="ops.reservation_task_templates"&&segments[2]==="tasks"){
   const field=segments[4];
   if(segments.length===5&&field!=="key"&&Object.hasOwn(reservationTaskTemplateSchema.shape,field))reservationTaskTemplateSchema.shape[field as keyof typeof reservationTaskTemplateSchema.shape].parse(value);
   else if(segments.length===7&&field==="checklist"&&segments[5].startsWith("@key:")&&segments[6]==="label")taskChecklistTemplateSchema.shape.label.strict().parse(value);
   else throw Error("native_onboarding_workflow_path_required");
  }else if(segments[1]==="ops.workflows"&&segments[2]==="workflows"){
   const field=segments[4];
   if(segments.length===5&&field==="trigger")z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/u).parse(value);
   else if(segments.length===5&&field==="version")z.number().int().positive().parse(value);
   else if(segments.length===5&&field==="idempotency_key")z.string().trim().min(1).max(180).parse(value);
   else if(field==="conditions"){
    const conditionPath=segments.slice(5);if(conditionPath.some(key=>!["all","any","not","path","op","value","field","config"].includes(key)))throw Error("native_onboarding_workflow_path_required");
    const leaf=conditionPath.at(-1);
    if(!leaf)ruleConditionSchema.parse(value);
    else if(["all","any","not"].includes(leaf))ruleConditionSchema.parse({[leaf]:value});
    else if(leaf==="path"||leaf==="field")pathValue.parse(value);
    else if(leaf==="config")z.string().max(160).parse(value);
    else if(leaf==="op")ruleConditionSchema.parse({path:"condition.value",op:value});
    else operandValue.parse(value);
   }else if(field==="actions"&&segments.length===5)z.array(automationActionSchema).min(1).parse(value);
   else throw Error("native_onboarding_workflow_path_required");
  }else throw Error("native_onboarding_workflow_path_required");
 }catch{context.addIssue({code:"custom",path:[path],message:"native_onboarding_workflow_path_required"});}
});
/** Step09 always applies a real standard template. Empty overrides explicitly retain inherited choices. */
export const onboardingWorkflowsTargetSchema=z.object({mode:z.literal("TEMPLATE"),propertyId:onboardingIdSchema,templateVersionId:onboardingIdSchema,expectedRevision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),overrides:onboardingWorkflowsOverridesSchema}).strict();
export const onboardingWorkflowsDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("WORKFLOWS"),target:onboardingWorkflowsTargetSchema}).strict();
export const onboardingWorkflowsCommandSchema=onboardingWorkflowsDraftSchema.extend({...onboardingCommandFields,reason:z.string().trim().min(6).max(500)});
export type OnboardingWorkflowsDraft=z.infer<typeof onboardingWorkflowsDraftSchema>;
export type OnboardingWorkflowsCommand=z.infer<typeof onboardingWorkflowsCommandSchema>;
export const canonicalOnboardingWorkflowsDraft=(raw:unknown)=>onboardingWorkflowsDraftSchema.parse(raw);
export const canonicalOnboardingWorkflowsCommand=(raw:unknown)=>onboardingWorkflowsCommandSchema.parse(raw);
