import {randomUUID} from "node:crypto";
import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {PropertyTemplateRepository} from "@/modules/core/infrastructure/property-template-repository";
import {TeamRepository} from "@/modules/identity/infrastructure/team-repository";
import {flattenSettings,inheritedChanges,writeSetting,validateTemplateValues,validateProjectedRules,validateTemplateDependencies,type TemplateValues} from "@/modules/core/domain/property-template";
import {TemplateAccessError,TemplateConflictError} from "@/modules/core/application/core-access";
import {onboardingWorkflowsTargetSchema,onboardingWorkflowsRuleKeys,onboardingWorkflowsSourceRuleKeys,onboardingWorkflowsOverridesSchema} from "@/modules/onboarding/domain/onboarding-workflows";

export {TemplateAccessError as NativeOnboardingWorkflowsAuthorizationError,TemplateConflictError as NativeOnboardingWorkflowsConflictError,TemplateNotFoundError as NativeOnboardingWorkflowsNotFoundError} from "@/modules/core/application/core-access";
export const nativeOnboardingWorkflowsTemplateHeads=(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplateHeads(ids,"WORKFLOW");
export const nativeOnboardingWorkflowsTemplateRows=async(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplateRows(ids,"WORKFLOW");
export const nativeOnboardingWorkflowsBindingHead=(tx:TenantTransaction,organizationId:string,propertyId:string)=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryBindingHead(propertyId,"WORKFLOW");
export const nativeOnboardingWorkflowsTemplatePage=(tx:TenantTransaction,organizationId:string,propertyId:string,query:string,after:string|undefined,asOf:Date)=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplatePage(propertyId,query,after,asOf,"WORKFLOW");
export const nativeOnboardingWorkflowsCommandRows=(tx:TenantTransaction,organizationId:string,propertyId:string,ids:readonly string[])=>new PropertyTemplateRepository(tx,organizationId).nativeWorkflowCommandRows(propertyId,ids);

/** Canonical inheritance runs first; explicit property changes then use the same keyed settings paths. */
export function previewNativeOnboardingWorkflowsTemplate(current:TemplateValues,selected:unknown,previousTemplate:unknown,rawOverrides:unknown){
 const after=structuredClone(current),base=flattenSettings(validateTemplateValues("WORKFLOW",selected as TemplateValues)),oldBase=previousTemplate===null?{}:flattenSettings(validateTemplateValues("WORKFLOW",previousTemplate as TemplateValues)),overrides=onboardingWorkflowsOverridesSchema.parse(rawOverrides);
 for(const[path,value]of Object.entries(inheritedChanges(current,oldBase,base)))writeSetting(after,path,value);
 for(const[path,value]of Object.entries(overrides)){if(!Object.hasOwn(base,path))throw new TemplateConflictError();writeSetting(after,path,value);}
 validateProjectedRules(after);validateTemplateDependencies("WORKFLOW",after);return after;
}

/** Both immutable canonical commands stay inside the native admission transaction. No runtime workflow executes here. */
export async function configureNativeOnboardingWorkflows(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,ownerId:string,raw:unknown,reason:string,requestId:string,operationId:string){
 const target=onboardingWorkflowsTargetSchema.parse(raw);if(target.propertyId!==propertyId)throw new TemplateAccessError();const core=new CoreRepository(tx,actor.organizationId),team=new TeamRepository(tx,actor.organizationId);await core.lockOnboardingProperty(propertyId);
 const check=async()=>{
  const[property]=await core.onboardingPropertyHeads([propertyId]),[account]=await team.onboardingTeamAccountHeads([actor.actorId]),current=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await core.clock();
  if(!property||!property.ownership.some(row=>row.ownerId===ownerId)||!account?.personId||account.status!=="ACTIVE"||actor.authContext.personId!==undefined&&actor.authContext.personId!==account.personId)throw new TemplateAccessError();const[person]=await team.onboardingTeamPersonHeads([account.personId]);if(!person)throw new TemplateAccessError();
  const scope={organizationId:actor.organizationId,propertyId,ownerId,city:property.cityId,region:property.regionId,status:property.status,occurredAt:property.createdAt};
  assertAccountAuthorization(actor,current,now,[{action:"view",resource:{...scope,type:"property",id:propertyId}},{action:"edit",resource:{...scope,type:"property",id:propertyId}},...onboardingWorkflowsRuleKeys.map(key=>({action:"configure"as const,resource:{...scope,type:"config_rule",id:key,status:"ACTIVE",occurredAt:now}})),...onboardingWorkflowsSourceRuleKeys.flatMap(key=>(["view","export"]as const).map(action=>({action,resource:{...scope,type:"config_rule",id:key,status:"ACTIVE",occurredAt:now}})))],new TemplateAccessError());
  const[template]=await nativeOnboardingWorkflowsTemplateHeads(tx,actor.organizationId,[target.templateVersionId]);if(!template||template.status!=="ACTIVE"||template.latestStatus!=="ACTIVE"||template.propertyId!==null&&template.propertyId!==propertyId)throw new TemplateAccessError();assertAccountAuthorization(actor,current,now,(["view","export"]as const).map(action=>({action,resource:{...scope,type:"config_rule",id:template.id,status:template.status,occurredAt:template.createdAt}})),new TemplateAccessError());return{...actor,personId:account.personId};
 };
 const ctx=await check(),commands:string[]=[];let applied;
 try{
  const{changePropertyTemplate}=await import("@/modules/core/application/property-template-service");applied=await changePropertyTemplate(ctx,{action:"APPLY",propertyId,ownerId,templateVersionId:target.templateVersionId,expectedRevision:target.expectedRevision,operationId,reason},{db:{$transaction:work=>work(tx)},requestId});
  commands.push(applied.id);
  if(Object.keys(target.overrides).length){applied=await changePropertyTemplate(ctx,{action:"OVERRIDE",kind:"WORKFLOW",propertyId,ownerId,values:target.overrides,expectedRevision:target.expectedRevision+1,operationId:randomUUID(),reason},{db:{$transaction:work=>work(tx)},requestId});commands.push(applied.id);}
 }catch(error){const{ConfigAuthorizationError}=await import("@/modules/config/application/config-service");if(error instanceof ConfigAuthorizationError)throw new TemplateAccessError();throw error;}
 const final=await check();if(final.personId!==ctx.personId)throw new TemplateAccessError();return{...applied,nativeCommands:await nativeOnboardingWorkflowsCommandRows(tx,actor.organizationId,propertyId,commands)};
}
