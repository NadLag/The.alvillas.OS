import {z} from "zod";
import {referencedConfigs} from "@/platform/automation/rule";
import {configRuleKeyInputSchema} from "@/platform/config/key-contract";
import {schemaForConfigKey,parseConfigRuleValue} from "@/platform/config/rule-registry";
import {onboardingIdSchema} from "./onboarding-contract";

export const onboardingConfigurationReferenceSchema=z.object({key:z.string(),id:onboardingIdSchema.nullable(),version:z.number().int().positive().nullable(),valid:z.boolean(),taskTemplateKey:z.string().nullable()}).strict().refine(value=>(value.id===null)===(value.version===null));
export const onboardingConfigurationReferenceCaptureSchema=z.object({key:z.string(),id:onboardingIdSchema,version:z.number().int().positive(),value:z.json()}).strict();
export function onboardingWorkflowReferenceKeys(settings:unknown){return referencedConfigs(settings).sort();}
export function registeredOnboardingReferenceKey(key:string){const parsed=configRuleKeyInputSchema.safeParse(key);return parsed.success&&parsed.data===key&&schemaForConfigKey(key)!==null;}
export function onboardingReferenceFact(key:string,metadata:{id:string;version:number}|null,rawValue:unknown){
 let valid=false,taskTemplateKey:string|null=null;if(metadata&&registeredOnboardingReferenceKey(key)){try{const value=parseConfigRuleValue(key,rawValue);valid=true;if(key==="ops.mid_stay_threshold"&&value!==null&&typeof value==="object"&&"task_template_key"in value&&typeof value.task_template_key==="string")taskTemplateKey=value.task_template_key;}catch{valid=false;}}
 return onboardingConfigurationReferenceSchema.parse({key,id:metadata?.id??null,version:metadata?.version??null,valid,taskTemplateKey});
}
