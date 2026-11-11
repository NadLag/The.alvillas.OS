"use client";
import {useTranslations} from "next-intl";
import type {z} from "zod";
import type {OnboardingTeamDraft,onboardingTeamSelectionSchema,onboardingTeamSnapshotSchema} from "../domain/onboarding-team";
import {OnboardingPropertyRecord} from "./onboarding-property-record";
import type {onboardingPropertyReviewSchema} from "../domain/onboarding-property";

type Selection=z.infer<typeof onboardingTeamSelectionSchema>;
type Snapshot=z.infer<typeof onboardingTeamSnapshotSchema>;
type Parent=Pick<z.infer<typeof onboardingPropertyReviewSchema>,"owner"|"property">;
export function OnboardingTeamRecord({review,reason}:{review:Parent&{draft:OnboardingTeamDraft;team:Snapshot|null;selection?:Selection};reason:string}){
 return <section className="resource-form" data-testid="onboarding-team-record"><OnboardingPropertyRecord review={{owner:review.owner,property:review.property}} reason={reason}/><OnboardingTeamValues team={review.team} selection={review.selection} proposedAssignments={review.draft.target.mode==="ASSIGN"?review.draft.target.assignments:[]}/></section>;
}
type ProposedAssignments=Extract<OnboardingTeamDraft["target"],{mode:"ASSIGN"}>["assignments"];
export function OnboardingTeamValues({team,selection:chosen,proposedAssignments=[]}:{team:Snapshot|null;selection?:Selection;proposedAssignments?:ProposedAssignments}){
 const t=useTranslations("OnboardingWizard"),selection=chosen??team,assignments=team?.assignments??proposedAssignments;
 return <section className="resource-form" data-testid="onboarding-team-values"><h3>{t("steps.TEAM")}</h3>{assignments.length===0&&<p>{t("team.emptyTeam")}</p>}{assignments.map((assignment,index)=>{
  const person=selection?.people.find(row=>row.id===assignment.personId),role=selection?.roles.find(row=>row.id===assignment.roleId),account=selection?.accounts.find(row=>row.id===assignment.userAccountId),conditions="conditions"in assignment?assignment.conditions:{assignedToMe:assignment.assignedToMe};
  return <section key={"id"in assignment?assignment.id:index} className="resource-form" data-testid="onboarding-team-record-assignment"><h4>{t("team.assignmentNumber",{number:index+1})}</h4><dl className="onboarding-values"><div><dt>{t("team.person")}</dt><dd dir="auto">{person?.displayName}</dd></div><div><dt>{t("team.role")}</dt><dd dir="auto">{role?.name}</dd></div><div><dt>{t("team.account")}</dt><dd dir="auto">{assignment.userAccountId===null?t("team.noAccount"):account?.email??t("team.selectedAccount")}</dd></div><div><dt>{t("team.validFrom")}</dt><dd><time dateTime={assignment.validFrom} dir="ltr">{assignment.validFrom}</time></dd></div><div><dt>{t("team.validTo")}</dt><dd>{assignment.validTo?<time dateTime={assignment.validTo} dir="ltr">{assignment.validTo}</time>:t("team.noEnd")}</dd></div><div><dt>{t("team.conditions")}</dt><dd className="onboarding-private-text" dir="ltr">{JSON.stringify(conditions)}</dd></div><div><dt>{t("team.permissions")}</dt><dd>{role?.permissionKeys.length?<ul className="onboarding-list">{role.permissionKeys.map(key=><li key={key} dir="ltr">{key}</li>)}</ul>:t("team.noPermissions")}</dd></div>{"archivedAt"in assignment&&assignment.archivedAt&&<div><dt>{t("team.archived")}</dt><dd><time dateTime={assignment.archivedAt}>{assignment.archivedAt}</time></dd></div>}</dl></section>;
 })}</section>;
}
