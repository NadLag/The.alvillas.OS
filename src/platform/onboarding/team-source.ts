import type {TenantTransaction} from "@/platform/db/tenant";
import {TeamRepository,type OnboardingTeamAssignmentHead,type OnboardingTeamPersonHead,type OnboardingTeamAccountHead,type OnboardingTeamRoleHead} from "@/modules/identity/infrastructure/team-repository";

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
