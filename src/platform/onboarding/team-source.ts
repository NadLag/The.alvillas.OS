import type {TenantTransaction} from "@/platform/db/tenant";
import {TeamRepository,type OnboardingTeamAssignmentHead,type OnboardingTeamPersonHead,type OnboardingTeamAccountHead,type OnboardingTeamRoleHead} from "@/modules/identity/infrastructure/team-repository";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {onboardingTeamTargetSchema} from "@/modules/onboarding/domain/onboarding-team";
import {onboardingTeamAssignmentReasonSchema} from "./contracts";

/** Internal source metadata only; the application authorizes actual rows before requesting private values. */
export const nativeOnboardingTeamAssignmentHeads=(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false)=>new TeamRepository(tx,organizationId).onboardingTeamAssignmentHeads(ids,includeArchived);
export const nativeOnboardingTeamPersonHeads=(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false)=>new TeamRepository(tx,organizationId).onboardingTeamPersonHeads(ids,includeArchived);
export const nativeOnboardingTeamAccountHeads=(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new TeamRepository(tx,organizationId).onboardingTeamAccountHeads(ids);
export const nativeOnboardingTeamRoleHeads=(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false)=>new TeamRepository(tx,organizationId).onboardingTeamRoleHeads(ids,includeArchived);
export const nativeOnboardingTeamAssignmentPage=(tx:TenantTransaction,organizationId:string,propertyId:string,after:string|undefined,asOf:Date)=>new TeamRepository(tx,organizationId).onboardingTeamAssignmentPage(propertyId,after,asOf);
/** Private source values: call only after independent current and held row authority. */
export const nativeOnboardingTeamAssignmentRows=(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false)=>new TeamRepository(tx,organizationId).onboardingTeamAssignmentRows(ids,includeArchived);
export const nativeOnboardingTeamPersonRows=(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false)=>new TeamRepository(tx,organizationId).onboardingTeamPersonRows(ids,includeArchived);
export const nativeOnboardingTeamAccountRows=(tx:TenantTransaction,organizationId:string,ids:readonly string[])=>new TeamRepository(tx,organizationId).onboardingTeamAccountRows(ids);
export const nativeOnboardingTeamRoleRows=(tx:TenantTransaction,organizationId:string,ids:readonly string[],includeArchived=false)=>new TeamRepository(tx,organizationId).onboardingTeamRoleRows(ids,includeArchived);
/** Plaintext witnesses contain identities and version pins; dates and staff/account/role values stay private. */
export function nativeOnboardingTeamSourcePins(assignments:readonly OnboardingTeamAssignmentHead[],people:readonly OnboardingTeamPersonHead[],accounts:readonly OnboardingTeamAccountHead[],roles:readonly OnboardingTeamRoleHead[]){
 const pin=(row:{id:string;rowVersion:string;tuple:string})=>({id:row.id,rowVersion:row.rowVersion,tuple:row.tuple});
 return{assignments:assignments.map(row=>({...pin(row),personId:row.personId,roleId:row.roleId,userAccountId:row.userAccountId,scopeType:row.scopeType,scopeId:row.scopeId})),people:people.map(pin),accounts:accounts.map(row=>({...pin(row),personId:row.personId})),roles:roles.map(row=>({...pin(row),permissionsHash:row.permissionsHash,permissionCount:row.permissionCount}))};
}

/** Internal admission adapter: authorize the selected sources first, then keep every canonical write in the caller's transaction. */
export async function createNativeOnboardingTeamAssignments(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown,reason:string,requestId:string){
 if(actor.organizationId!==actor.authContext.organizationId||actor.actorId!==actor.authContext.userAccountId)throw Error("native_onboarding_team_actor_required");
 const input=onboardingTeamTargetSchema.parse({mode:"ASSIGN",propertyId,assignments:raw}),canonicalReason=onboardingTeamAssignmentReasonSchema.parse(reason),repository=new TeamRepository(tx,actor.organizationId),[account]=await repository.onboardingTeamAccountHeads([actor.actorId]);
 if(input.mode!=="ASSIGN")throw Error("native_onboarding_team_assignment_required");
 if(!account?.personId||account.status!=="ACTIVE"||actor.authContext.personId!==undefined&&actor.authContext.personId!==account.personId)throw Error("native_onboarding_team_actor_required");
 // Different Properties can share people. Acquire the complete batch in one stable order.
 for(const id of[...new Set(input.assignments.map(row=>row.personId))].sort())await repository.lock(id);
 const {assignTeamRole}=await import("@/modules/identity/application/team-service"),ctx={...actor,personId:account.personId},ids:string[]=[];
 for(const assignment of input.assignments){const result=await assignTeamRole(ctx,{...assignment,scopeType:"property",scopeId:input.propertyId,reason:canonicalReason},{db:{$transaction:work=>work(tx)},requestId,propertyScopeId:input.propertyId});if(!result.created)throw Error("native_onboarding_team_existing_assignment_conflict");ids.push(result.id);}
 return ids;
}
