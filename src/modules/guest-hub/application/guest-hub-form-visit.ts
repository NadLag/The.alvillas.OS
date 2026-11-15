import {authorize,type AuthContext,type Resource} from "@/platform/authz/authorize";
import {consumeRateLimit} from "@/platform/rate-limit/postgres-rate-limiter";
import {withGuestHubCapability,type GuestHubCapabilityContext,type GuestHubVisitDependencies} from "./guest-hub-visit";

type FormState={grant:{createdAt:Date;expiresAt:Date};now:Date;fingerprint:string;policy:{limits:Array<{requests:number;window_seconds:number}>}};
export type GuestHubFormContext<Form extends FormState>=GuestHubCapabilityContext&{form:Form;formAuthority:AuthContext;formResource:Resource};
type Definition<Form extends FormState>={resourceType:"guest_hub_profile"|"guest_hub_stay_details"|"guest_hub_identity_documents";rateKey:string;active:(context:Pick<GuestHubCapabilityContext,"tx"|"actual">,env?:NodeJS.ProcessEnv)=>Promise<Form>;lock:(context:GuestHubCapabilityContext)=>Promise<void>;AccessError:new()=>Error;isValidation?:(error:unknown)=>boolean};
/** A field-validation result is released only after the same final source/form fences as a successful command. */
export async function withGuestHubForm<Form extends FormState,Result>(capability:unknown,deps:GuestHubVisitDependencies,definition:Definition<Form>,work:(context:GuestHubFormContext<Form>)=>Promise<Result>,submission=false):Promise<Result>{
 let expected:string|undefined,authority:AuthContext|undefined,resource:Resource|undefined;
 const result=await withGuestHubCapability(capability,deps,async context=>{
  const form=await definition.active(context,deps.env);await definition.lock(context);const permission=new Set([definition.resourceType+":view",definition.resourceType+":create"]),scope={organizationId:context.actual.row.organizationId,resourceType:definition.resourceType,resourceId:context.actual.row.id};
  authority={organizationId:context.actual.row.organizationId,permissions:permission,scopes:[scope],assignments:[{permissions:permission,scope,validFrom:form.grant.createdAt,validTo:form.grant.expiresAt}]};resource={...context.resource,type:definition.resourceType,id:context.actual.row.id,dataClass:"personal"};
  if(!authorize(authority,submission?"create":"view",resource,form.now))throw new definition.AccessError();expected=form.fingerprint;
  try{return{valid:true as const,value:await work({...context,form,formAuthority:authority,formResource:resource})};}catch(error){if(definition.isValidation?.(error))return{valid:false as const,error};throw error;}
 },submission?async context=>{
  const form=await definition.active(context,deps.env),limits=new Map<number,number>();for(const limit of form.policy.limits)limits.set(limit.window_seconds,Math.min(limits.get(limit.window_seconds)??limit.requests,limit.requests));
  let allowed=true;for(const[windowSeconds,limit]of limits){const current=await consumeRateLimit(context.tx,context.actual.row.organizationId,{key:definition.rateKey+context.actual.row.id,limit,windowSeconds,now:form.now});allowed=current.allowed&&allowed;}return allowed;
 }:undefined,async context=>{const final=await definition.active(context,deps.env);if(final.fingerprint!==expected||!authority||!resource||!authorize(authority,submission?"create":"view",resource,final.now))throw new definition.AccessError();});
 if(!result.valid)throw result.error;return result.value;
}
