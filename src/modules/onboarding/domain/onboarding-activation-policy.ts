import {z} from "zod";

export const onboardingActivationEffects=["WORKFLOWS","DOCUMENTS","EMAIL","TASKS","NOTIFICATION"]as const;
export const onboardingActivationEffectSchema=z.enum(onboardingActivationEffects);
export const onboardingActivationDependencies:Readonly<Record<typeof onboardingActivationEffects[number],readonly typeof onboardingActivationEffects[number][]>>={WORKFLOWS:[],DOCUMENTS:["WORKFLOWS"],EMAIL:["DOCUMENTS"],TASKS:["WORKFLOWS"],NOTIFICATION:["EMAIL","TASKS"]};
/** Required effects come from the locked product contract; retry choices require approved configuration. */
export const onboardingActivationPolicySchema=z.object({
 modes:z.array(z.literal("BACKGROUND")).length(1),
 effects:z.array(onboardingActivationEffectSchema).length(onboardingActivationEffects.length),
 retry:z.object({max_attempts:z.number().int().min(1).max(25),backoff_seconds:z.number().int().min(1).max(3600)}).strict()
}).strict().superRefine((value,context)=>{
 if(new Set(value.effects).size!==onboardingActivationEffects.length)context.addIssue({code:"custom",message:"all_activation_effects_exactly_once",path:["effects"]});
 for(const[kind,dependencies]of Object.entries(onboardingActivationDependencies))for(const dependency of dependencies)if(value.effects.indexOf(dependency)>=value.effects.indexOf(kind as typeof onboardingActivationEffects[number]))context.addIssue({code:"custom",message:"activation_dependency_order_required",path:["effects"]});
});
export type OnboardingActivationPolicy=z.infer<typeof onboardingActivationPolicySchema>;
