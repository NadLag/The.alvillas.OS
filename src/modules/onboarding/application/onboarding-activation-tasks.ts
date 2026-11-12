import {withTenant} from "@/platform/db/tenant";
import {authorizeCollection} from "@/platform/authz/authorize";
import {recheckAccountAuthorization} from "@/platform/authz/current-authority";
import {jsonbFingerprint} from "@/platform/http/command-fingerprint";
import {createOnboardingTask} from "@/platform/onboarding/task-write";
import {compileOnboardingActivationTasks} from "../domain/onboarding-activation-tasks";
import {OnboardingAccessError,OnboardingConflictError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";
import {nativeOnboardingActivationAccess,type OnboardingDependencies} from "./onboarding-service";
import {nativeOnboardingActivationWorkflowSource,recheckOnboardingActivationWorkflowSource} from "./onboarding-activation-workflow-source";

/** Creates only the explicitly approved activation tasks; native phase completion stays protected. */
export async function materializeOnboardingActivationTasks(organizationId:string,activationId:string,deps:OnboardingDependencies){return withTenant(deps.db,organizationId,async tx=>{
 const access=await nativeOnboardingActivationAccess(organizationId,tx,activationId),native=new OnboardingRepository(tx,organizationId),resource={type:"task",organizationId,propertyId:access.row.propertyId,ownerId:access.row.ownerId,city:access.property.cityId,region:access.property.regionId};
 if(![access.actor.authContext,access.current.stored].every(context=>authorizeCollection(context,"create","task")))throw new OnboardingAccessError();
 const authorizeDestination=async()=>recheckAccountAuthorization(access.actor,tx,await native.clock(),(["create","view"]as const).map(action=>({action,resource})),new OnboardingAccessError());
 await authorizeDestination();await native.lockSession(access.row.sessionId);
 const source=await nativeOnboardingActivationWorkflowSource(organizationId,tx,activationId,deps),plan=compileOnboardingActivationTasks({organizationId,propertyId:source.run.row.propertyId,activationId:source.run.row.id,requestedAt:source.run.row.createdAt},source.original.value),tasks=[];
 for(const item of plan){await authorizeDestination();const task=await createOnboardingTask({...source.run.actor,personId:source.run.actor.authContext.personId!},item.command,{db:{$transaction:work=>work(tx)},requestId:deps.requestId});if(task.organizationId!==organizationId||task.propertyId!==source.run.row.propertyId)throw new OnboardingConflictError();await authorizeDestination();tasks.push({key:item.key,taskId:task.id,version:task.version,state:task.state,commandKey:item.command.idempotencyKey});}
 await recheckOnboardingActivationWorkflowSource(organizationId,tx,activationId,source,deps);await authorizeDestination();
 return{activationId:source.run.row.id,propertyId:source.run.row.propertyId,sourceRuleId:source.source.id,sourceFingerprint:jsonbFingerprint(source.original.value),tasks};
},{timeout:120000});}
