import {z} from "zod";
import {calendarDateAt} from "@/i18n/format";
import {configSlugSchema} from "@/platform/config/identifiers";
import {workflowCatalogSchema} from "@/platform/config/workflow-policy";
import {operationIdentity} from "@/platform/idempotency/operation-identity";
import {createTaskSchema} from "@/platform/onboarding/task-contracts";
import {onboardingIdSchema} from "./onboarding-primitives";
import {OnboardingConfigurationError} from "./onboarding-wizard";

const timezone=z.string().min(1).max(100).refine(value=>{try{new Intl.DateTimeFormat("en",{timeZone:value});return true;}catch{return false;}});
const task=createTaskSchema.pick({type:true,title:true,priority:true,checklistTemplateKey:true}).extend({key:configSlugSchema,due:z.object({anchor:z.literal("ACTIVATION_REQUEST"),timezone,offset_days:z.number().int().min(-366).max(366)}).strict()}).strict();
const catalog=z.object({onboarding_tasks:z.object({minimum:z.number().int().min(0).max(100),items:z.array(task).max(100).refine(items=>new Set(items.map(item=>item.key)).size===items.length)}).strict().refine(value=>value.items.length>=value.minimum)}).passthrough();
const binding=z.object({organizationId:onboardingIdSchema,propertyId:onboardingIdSchema,activationId:onboardingIdSchema,requestedAt:z.date()}).strict();

/** All task choices, including calendar zone and offset, belong to the actual approved workflow catalog. */
export function compileOnboardingActivationTasks(rawBinding:z.infer<typeof binding>,raw:unknown){
 const context=binding.safeParse(rawBinding),configured=catalog.safeParse(raw);if(!context.success||!configured.success||!workflowCatalogSchema.safeParse(raw).success)throw new OnboardingConfigurationError();
 return configured.data.onboarding_tasks.items.map(item=>{
  const day=calendarDateAt(context.data.requestedAt,item.due.timezone),date=new Date(day+"T00:00:00.000Z");date.setUTCDate(date.getUTCDate()+item.due.offset_days);
  const command=createTaskSchema.parse({propertyId:context.data.propertyId,type:item.type,title:item.title,priority:item.priority,checklistTemplateKey:item.checklistTemplateKey,dueDate:date.toISOString().slice(0,10),idempotencyKey:operationIdentity(JSON.stringify(["native-onboarding-task-v1",context.data.organizationId,context.data.propertyId,context.data.activationId,item.key])),reason:"onboarding.activation.tasks:"+context.data.activationId+":"+item.key});
  return{key:item.key,command};
 });
}
