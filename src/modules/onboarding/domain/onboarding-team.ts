import {z} from "zod";
import {onboardingTeamAssignmentInputSchema,onboardingTeamAssignmentReasonSchema} from "@/platform/onboarding/contracts";
import {onboardingIdSchema,onboardingCommandFields,onboardingOwnerSchema,onboardingFingerprintSchema,onboardingReceiptSchema,onboardingProgressMatches} from "./onboarding-contract";
import {onboardingTeamMaximumAssignments,onboardingStepSchema} from "./onboarding-policy";
import {onboardingPropertySnapshotSchema} from "./onboarding-property";

export const onboardingTeamTargetSchema=z.discriminatedUnion("mode",[
 z.object({mode:z.literal("LINK"),propertyId:onboardingIdSchema,assignmentIds:z.array(onboardingIdSchema).max(onboardingTeamMaximumAssignments).refine(values=>new Set(values).size===values.length)}).strict(),
 z.object({mode:z.literal("ASSIGN"),propertyId:onboardingIdSchema,assignments:z.array(onboardingTeamAssignmentInputSchema).min(1).max(onboardingTeamMaximumAssignments).refine(values=>new Set(values.map(value=>JSON.stringify(value))).size===values.length)}).strict()
]);
export const onboardingTeamDraftSchema=z.object({sessionId:onboardingIdSchema,previousRevisionId:onboardingIdSchema,step:z.literal("TEAM"),target:onboardingTeamTargetSchema}).strict();
export const onboardingTeamCommandSchema=onboardingTeamDraftSchema.extend({...onboardingCommandFields,reason:onboardingTeamAssignmentReasonSchema});
export type OnboardingTeamDraft=z.infer<typeof onboardingTeamDraftSchema>;
export type OnboardingTeamCommand=z.infer<typeof onboardingTeamCommandSchema>;
export const onboardingTeamAssignmentSnapshotSchema=z.object({id:onboardingIdSchema,personId:onboardingIdSchema,roleId:onboardingIdSchema,userAccountId:onboardingIdSchema.nullable(),scopeType:z.literal("property"),scopeId:onboardingIdSchema,conditions:z.json().nullable(),validFrom:z.iso.datetime(),validTo:z.iso.datetime().nullable(),archivedAt:z.iso.datetime().nullable(),createdBy:onboardingIdSchema.nullable(),createdAt:z.iso.datetime()}).strict().refine(value=>value.validTo===null||Date.parse(value.validTo)>Date.parse(value.validFrom));
export const onboardingTeamSnapshotSchema=z.object({
 propertyId:onboardingIdSchema,
 assignments:z.array(onboardingTeamAssignmentSnapshotSchema).max(onboardingTeamMaximumAssignments),
 people:z.array(z.object({id:onboardingIdSchema,displayName:z.string(),archivedAt:z.iso.datetime().nullable()}).strict()).max(onboardingTeamMaximumAssignments),
 accounts:z.array(z.object({id:onboardingIdSchema,personId:onboardingIdSchema.nullable(),email:z.string().nullable(),status:z.string()}).strict()).max(onboardingTeamMaximumAssignments),
 roles:z.array(z.object({id:onboardingIdSchema,key:z.string(),name:z.string(),archivedAt:z.iso.datetime().nullable(),permissionKeys:z.array(z.string()).refine(keys=>new Set(keys).size===keys.length)}).strict()).max(onboardingTeamMaximumAssignments)
}).strict().superRefine((value,context)=>{
 const ids=(rows:readonly{id:string}[])=>new Set(rows.map(row=>row.id)),people=ids(value.people),accounts=ids(value.accounts),roles=ids(value.roles),usedPeople=new Set(value.assignments.map(row=>row.personId)),usedRoles=new Set(value.assignments.map(row=>row.roleId)),usedAccounts=new Set(value.assignments.flatMap(row=>row.userAccountId?[row.userAccountId]:[]));
 if(ids(value.assignments).size!==value.assignments.length||people.size!==value.people.length||accounts.size!==value.accounts.length||roles.size!==value.roles.length||people.size!==usedPeople.size||roles.size!==usedRoles.size||accounts.size!==usedAccounts.size||value.assignments.some(row=>row.scopeId!==value.propertyId||!people.has(row.personId)||!roles.has(row.roleId)||row.userAccountId!==null&&(!accounts.has(row.userAccountId)||value.accounts.find(account=>account.id===row.userAccountId)?.personId!==row.personId)))context.addIssue({code:"custom",message:"native_onboarding_original_property_team_required"});
});
export type OnboardingTeamSnapshot=z.infer<typeof onboardingTeamSnapshotSchema>;
export const onboardingTeamSelectionSchema=z.object({people:onboardingTeamSnapshotSchema.shape.people,accounts:onboardingTeamSnapshotSchema.shape.accounts,roles:onboardingTeamSnapshotSchema.shape.roles}).strict();
export const onboardingTeamOptionsSchema=z.object({revisionId:onboardingIdSchema,propertyId:onboardingIdSchema,propertyName:z.string(),modes:z.array(z.enum(["LINK","ASSIGN"])).min(1).max(2).refine(values=>new Set(values).size===values.length),minimumAssignments:z.number().int().min(0).max(onboardingTeamMaximumAssignments)}).strict();
export const onboardingTeamReviewSchema=z.object({draft:onboardingTeamDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema,team:onboardingTeamSnapshotSchema.nullable(),selection:onboardingTeamSelectionSchema,reviewFingerprint:onboardingFingerprintSchema}).strict().superRefine((value,context)=>{
 const target=value.draft.target,rows=target.mode==="LINK"?value.team?.assignments:target.assignments,selection=value.selection,ids=(rows:readonly{id:string}[])=>new Set(rows.map(row=>row.id)),people=ids(selection.people),roles=ids(selection.roles),accounts=ids(selection.accounts);
 if(target.propertyId!==value.property.id||!rows||people.size!==selection.people.length||roles.size!==selection.roles.length||accounts.size!==selection.accounts.length||people.size!==new Set(rows.map(row=>row.personId)).size||roles.size!==new Set(rows.map(row=>row.roleId)).size||accounts.size!==new Set(rows.flatMap(row=>row.userAccountId?[row.userAccountId]:[])).size||rows.some(row=>!people.has(row.personId)||!roles.has(row.roleId)||row.userAccountId!==null&&(!accounts.has(row.userAccountId)||selection.accounts.find(account=>account.id===row.userAccountId)?.personId!==row.personId))||target.mode==="LINK"&&(value.team?.propertyId!==value.property.id||rows.length!==target.assignmentIds.length||value.team.assignments.some(row=>!target.assignmentIds.includes(row.id)))||target.mode==="ASSIGN"&&(value.team!==null||selection.people.some(row=>row.archivedAt!==null)||selection.roles.some(row=>row.archivedAt!==null)||selection.accounts.some(row=>row.status!=="ACTIVE")))context.addIssue({code:"custom",message:"native_onboarding_authorized_team_selection_required"});
});
export const onboardingTeamReadSchema=z.object({sessionId:onboardingIdSchema,current:onboardingReceiptSchema,selected:onboardingReceiptSchema,draft:onboardingTeamDraftSchema,owner:onboardingOwnerSchema,property:onboardingPropertySnapshotSchema,previousTeam:onboardingTeamSnapshotSchema,team:onboardingTeamSnapshotSchema,reason:z.string(),history:z.array(onboardingReceiptSchema).max(20),next:z.number().int().positive().nullable(),completed:z.array(onboardingStepSchema),nextStep:onboardingStepSchema.nullable()}).strict().superRefine((value,context)=>{
 if(!onboardingProgressMatches(value)||value.selected.step!=="TEAM"||value.draft.sessionId!==value.sessionId||value.draft.previousRevisionId!==value.selected.previousRevisionId||value.selected.propertyId!==value.property.id||value.draft.target.propertyId!==value.property.id||value.team.propertyId!==value.property.id||value.previousTeam.propertyId!==value.property.id||value.draft.target.mode==="LINK"&&(value.team.assignments.length!==value.draft.target.assignmentIds.length||value.team.assignments.some(row=>value.draft.target.mode!=="LINK"||!value.draft.target.assignmentIds.includes(row.id)))||value.draft.target.mode==="ASSIGN"&&value.previousTeam.assignments.length!==0)context.addIssue({code:"custom",message:"native_onboarding_original_team_required"});
});
export function canonicalOnboardingTeamDraft(raw:unknown):OnboardingTeamDraft{
 const value=onboardingTeamDraftSchema.parse(raw);return{sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:"TEAM",target:value.target};
}
export function canonicalOnboardingTeamCommand(raw:unknown):OnboardingTeamCommand{
 const value=onboardingTeamCommandSchema.parse(raw);return{...canonicalOnboardingTeamDraft({sessionId:value.sessionId,previousRevisionId:value.previousRevisionId,step:value.step,target:value.target}),idempotencyKey:value.idempotencyKey,reviewFingerprint:value.reviewFingerprint,reason:value.reason};
}
