import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {CoreRepository} from "@/modules/core/infrastructure/core-repository";
import {PropertyTemplateRepository} from "@/modules/core/infrastructure/property-template-repository";
import {onboardingInventoryTargetSchema} from "@/modules/onboarding/domain/onboarding-inventory";
import {canonicalOnboardingInventorySettings,onboardingInventoryRuleKey} from "./contracts";
import {TemplateAccessError} from "@/modules/core/application/core-access";
import {TeamRepository} from "@/modules/identity/infrastructure/team-repository";
import {flattenSettings,inheritedChanges,writeSetting,validateTemplateValues,validateProjectedRules,type TemplateValues} from "@/modules/core/domain/property-template";

export {TemplateAccessError as NativeOnboardingInventoryAuthorizationError,TemplateConflictError as NativeOnboardingInventoryConflictError,TemplateNotFoundError as NativeOnboardingInventoryNotFoundError} from "@/modules/core/application/core-access";
export const nativeOnboardingInventoryTemplateHeads=(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplateHeads(ids);
export const nativeOnboardingInventoryTemplateRows=async(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplateRows(ids);
export const nativeOnboardingInventoryBindingHead=(tx:TenantTransaction,organizationId:string,propertyId:string)=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryBindingHead(propertyId);
export const nativeOnboardingInventoryTemplatePage=(tx:TenantTransaction,organizationId:string,propertyId:string,query:string,after:string|undefined,asOf:Date)=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplatePage(propertyId,query,after,asOf);
export const nativeOnboardingInventoryTemplateChoiceRows=async(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new PropertyTemplateRepository(tx,organizationId).nativeInventoryTemplateChoiceRows(ids);

/** Preview the canonical inheritance algorithm, including existing property overrides, without writing a second template model. */
export function previewNativeOnboardingInventoryTemplate(current:unknown,selected:unknown,previousTemplate:unknown){
 const before:TemplateValues=current===null?{rules:{}}:{rules:{[onboardingInventoryRuleKey]:current}},after=structuredClone(before),base=flattenSettings(validateTemplateValues("INVENTORY",selected as TemplateValues)),oldBase=previousTemplate===null?{}:flattenSettings(validateTemplateValues("INVENTORY",previousTemplate as TemplateValues));
 for(const[path,value]of Object.entries(inheritedChanges(before,oldBase,base)))writeSetting(after,path,value);
 validateProjectedRules(after);return after.rules?.[onboardingInventoryRuleKey]??null;
}

/** Both native modes keep the canonical writer, audit and configuration history inside the caller's transaction. */
export async function configureNativeOnboardingInventory(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown,reason:string,requestId:string,operationId:string){
 const target=onboardingInventoryTargetSchema.parse(raw);if(target.propertyId!==propertyId)throw Error("native_onboarding_inventory_property_required");
 const core=new CoreRepository(tx,actor.organizationId),team=new TeamRepository(tx,actor.organizationId);await core.lockOnboardingProperty(propertyId);
 const check=async()=>{const[property]=await core.onboardingPropertyHeads([propertyId]),[account]=await team.onboardingTeamAccountHeads([actor.actorId]),current=await authContextForAccountInTransaction(tx,actor.organizationId,actor.actorId),now=await core.clock();if(!property||!account?.personId||account.status!=="ACTIVE"||actor.authContext.personId!==undefined&&actor.authContext.personId!==account.personId)throw new TemplateAccessError();const[person]=await team.onboardingTeamPersonHeads([account.personId]);if(!person)throw new TemplateAccessError();const scope={organizationId:actor.organizationId,propertyId,city:property.cityId,region:property.regionId,status:property.status,occurredAt:property.createdAt};assertAccountAuthorization(actor,current,now,[{action:"view",resource:{...scope,type:"property",id:propertyId}},{action:"edit",resource:{...scope,type:"property",id:propertyId}},{action:"configure",resource:{...scope,type:"config_rule",id:onboardingInventoryRuleKey,status:"ACTIVE",occurredAt:now}}],new TemplateAccessError());return{...actor,personId:account.personId};};
 const ctx=await check();let result;
 if(target.mode==="TEMPLATE"){const{changePropertyTemplate}=await import("@/modules/core/application/property-template-service");result=await changePropertyTemplate(ctx,{action:"APPLY",propertyId,templateVersionId:target.templateVersionId,expectedRevision:target.expectedRevision,operationId,reason},{db:{$transaction:work=>work(tx)},requestId});}
 else{const{writePropertyConfiguration}=await import("@/platform/config/property-configuration");result=await writePropertyConfiguration(ctx,{propertyId,key:onboardingInventoryRuleKey,value:canonicalOnboardingInventorySettings(target.settings),reason},{tx,requestId,ipAddress:null});}
 const final=await check();if(final.personId!==ctx.personId)throw new TemplateAccessError();return result;
}
