import type {TenantTransaction} from "@/platform/db/tenant";
import type {AccountActorContext} from "@/platform/authz/session-context";
import {authContextForAccountInTransaction} from "@/platform/authz/account-context";
import {assertAccountAuthorization,type CurrentAuthorityCheck} from "@/platform/authz/current-authority";
import {authorize,type Resource} from "@/platform/authz/authorize";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {nativeOnboardingPropertyHeads} from "@/platform/onboarding/property-source";
import {nativeOnboardingTeamAssignmentHeads,nativeOnboardingTeamPersonHeads,nativeOnboardingTeamRoleHeads,nativeOnboardingTeamAccountHeads,nativeOnboardingTeamPersonScopes,nativeOnboardingTeamAssignmentRows,nativeOnboardingTeamPersonRows,nativeOnboardingTeamRoleRows,nativeOnboardingTeamAccountRows,nativeOnboardingTeamSourcePins} from "@/platform/onboarding/team-source";
import {onboardingTeamTargetSchema,onboardingTeamSnapshotSchema} from "../domain/onboarding-team";
import {OnboardingAccessError,OnboardingConflictError} from "../domain/onboarding-wizard";
import {OnboardingRepository} from "../infrastructure/onboarding-repository";

/** Internal source boundary. Parent-session/Owner authority and private read audit belong to the calling native admission/read. */
export async function readOnboardingTeamSources(actor:AccountActorContext,tx:TenantTransaction,propertyId:string,raw:unknown){
 const target=onboardingTeamTargetSchema.parse(raw);if(target.propertyId!==propertyId)throw new OnboardingAccessError();
 const organizationId=actor.organizationId,now=await new OnboardingRepository(tx,organizationId).clock(),stored=await authContextForAccountInTransaction(tx,organizationId,actor.actorId),[actualActor]=await nativeOnboardingTeamAccountHeads(tx,organizationId,[actor.actorId]),[property]=await nativeOnboardingPropertyHeads(tx,organizationId,[propertyId]);
 if(!actualActor||actualActor.status!=="ACTIVE"||actor.authContext.personId!==undefined&&actor.authContext.personId!==actualActor.personId)throw new OnboardingAccessError();
 if(!property)throw new OnboardingAccessError();
 const propertyResource:Resource={type:"property",organizationId,id:property.id,propertyId:property.id,city:property.cityId,region:property.regionId,status:property.status,occurredAt:property.createdAt};
 const entryChecks:CurrentAuthorityCheck[]=[{action:"view",resource:propertyResource},{action:"view",resource:{...propertyResource,type:"team_member",id:undefined}}];
 assertAccountAuthorization(actor,stored,now,entryChecks,new OnboardingAccessError());
 const assignments=target.mode==="LINK"?await nativeOnboardingTeamAssignmentHeads(tx,organizationId,target.assignmentIds):[];
 if(target.mode==="LINK"&&(assignments.length!==target.assignmentIds.length||assignments.some(row=>row.scopeType!=="property"||row.scopeId!==propertyId)))throw new OnboardingAccessError();
 const selected=target.mode==="LINK"?assignments:target.assignments,personIds=[...new Set(selected.map(row=>row.personId))],roleIds=[...new Set(selected.map(row=>row.roleId))],accountIds=[...new Set(selected.flatMap(row=>row.userAccountId?[row.userAccountId]:[]))];
 const people=await nativeOnboardingTeamPersonHeads(tx,organizationId,personIds),roles=await nativeOnboardingTeamRoleHeads(tx,organizationId,roleIds),accounts=await nativeOnboardingTeamAccountHeads(tx,organizationId,accountIds),scopes=await nativeOnboardingTeamPersonScopes(tx,organizationId,personIds,now);
 if(people.length!==personIds.length||roles.length!==roleIds.length||accounts.length!==accountIds.length||roles.some(row=>!row.permissionsValid)||selected.some(row=>row.userAccountId!==null&&accounts.find(account=>account.id===row.userAccountId)?.personId!==row.personId))throw new OnboardingAccessError();
 const teamResource=(personId:string):Resource=>({type:"team_member",organizationId,id:personId,assignedPersonId:personId});
 const checks:CurrentAuthorityCheck[]=roles.map(row=>({action:"view",resource:{type:"role",organizationId,id:row.id}}));
 for(const account of accounts)checks.push({action:"view",resource:{type:"identity",organizationId,id:account.id,assignedPersonId:account.personId}});
 // Only actual current memberships can supply a Person's geography. Proposed assignments supply no visibility.
 for(const personId of personIds){const base=teamResource(personId),candidates=[base,...scopes.filter(row=>row.personId===personId).map(row=>({...base,propertyId:row.propertyId,city:row.city,region:row.region,jobId:row.jobId}))],candidate=candidates.find(resource=>[actor.authContext,stored].every(context=>authorize(context,"view",resource,now)));if(!candidate)throw new OnboardingAccessError();checks.push({action:"view",resource:candidate});}
 for(const row of assignments)checks.push({action:"view",resource:{...teamResource(row.personId),propertyId,city:property.cityId,region:property.regionId,occurredAt:row.createdAt}});
 assertAccountAuthorization(actor,stored,now,checks,new OnboardingAccessError());
 const pins=nativeOnboardingTeamSourcePins(assignments,people,accounts,roles),witness=commandFingerprint({pins,scopes,property}),assignmentRows=await nativeOnboardingTeamAssignmentRows(tx,organizationId,assignments.map(row=>row.id)),personRows=await nativeOnboardingTeamPersonRows(tx,organizationId,personIds),roleRows=await nativeOnboardingTeamRoleRows(tx,organizationId,roleIds),accountRows=await nativeOnboardingTeamAccountRows(tx,organizationId,accountIds);
 const freshNow=await new OnboardingRepository(tx,organizationId).clock(),freshStored=await authContextForAccountInTransaction(tx,organizationId,actor.actorId),freshAssignments=await nativeOnboardingTeamAssignmentHeads(tx,organizationId,assignments.map(row=>row.id)),freshPeople=await nativeOnboardingTeamPersonHeads(tx,organizationId,personIds),freshRoles=await nativeOnboardingTeamRoleHeads(tx,organizationId,roleIds),freshAccounts=await nativeOnboardingTeamAccountHeads(tx,organizationId,accountIds),freshScopes=await nativeOnboardingTeamPersonScopes(tx,organizationId,personIds,freshNow),[freshProperty]=await nativeOnboardingPropertyHeads(tx,organizationId,[propertyId]);
 assertAccountAuthorization(actor,freshStored,freshNow,[...entryChecks,...checks],new OnboardingAccessError());
 if(witness!==commandFingerprint({pins:nativeOnboardingTeamSourcePins(freshAssignments,freshPeople,freshAccounts,freshRoles),scopes:freshScopes,property:freshProperty})||assignmentRows.length!==assignments.length||personRows.length!==people.length||roleRows.length!==roles.length||accountRows.length!==accounts.length)throw new OnboardingConflictError();
 const privateSelection={people:personRows.map(row=>({...row,archivedAt:row.archivedAt?.toISOString()??null})),roles:roleRows.map(row=>({...row,archivedAt:row.archivedAt?.toISOString()??null})),accounts:accountRows};
 const snapshot=target.mode==="LINK"?onboardingTeamSnapshotSchema.parse({propertyId,assignments:assignmentRows.map(row=>({...row,validFrom:row.validFrom.toISOString(),validTo:row.validTo?.toISOString()??null,createdAt:row.createdAt.toISOString(),archivedAt:row.archivedAt?.toISOString()??null})),...privateSelection}):null;
 return{target,pins,sourceFingerprint:witness,snapshot,selection:privateSelection};
}
