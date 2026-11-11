import {z} from "zod";
import {onboardingTemplateSettings,onboardingTemplateSettingValue,onboardingTemplatePathSegments} from "@/platform/onboarding/template-contracts";
import {onboardingWorkflowsOverridesSchema} from "./onboarding-workflows";

export const onboardingWorkflowsOverrideFieldSchema=z.object({path:z.string().max(600),kind:z.enum(["TASK","WORKFLOW"]),key:z.string().max(120),label:z.enum(["title","checklist","type","due","dueOffsetDays","priority","checklistTemplateKey","trigger","version","idempotency_key","conditions","actions"]),parameter:z.string().max(120).nullable(),itemKey:z.string().max(120).nullable(),value:z.json(),inheritedValue:z.json()}).strict();
export const onboardingWorkflowsOverrideFieldsSchema=z.array(onboardingWorkflowsOverrideFieldSchema).max(500);
/** Only selected-template paths accepted by the canonical override grammar become editable public fields. */
export function onboardingWorkflowsOverrideFields(selected:unknown,proposed:unknown,inherited:unknown=proposed){
 const rows=[];for(const[path]of Object.entries(onboardingTemplateSettings(selected))){
  const value=onboardingTemplateSettingValue(proposed,path);if(!onboardingWorkflowsOverridesSchema.safeParse({[path]:value}).success)continue;
  const segments=onboardingTemplatePathSegments(path),task=segments[1]==="ops.reservation_task_templates",field=segments[4],label=task?(field==="checklist"?"checklist":field):field==="conditions"?"conditions":field,parsed=onboardingWorkflowsOverrideFieldSchema.safeParse({path,kind:task?"TASK":"WORKFLOW",key:segments[3].slice(5),label,parameter:field==="actions"&&segments.length===7?segments[6]:field==="conditions"?segments.at(-1):null,itemKey:(field==="checklist"||field==="actions")&&segments[5]?.startsWith("@key:")?segments[5].slice(5):null,value,inheritedValue:onboardingTemplateSettingValue(inherited,path)});if(parsed.success)rows.push(parsed.data);
 }return onboardingWorkflowsOverrideFieldsSchema.parse(rows);
}
