import {ZodError} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {authContextForAccountInTransaction,contextForRoleAssignments} from "@/platform/authz/account-context";
import {IdentityRepository} from "@/modules/identity/infrastructure/identity-repository";
import {securityEnrollment} from "@/platform/auth/security-enrollment";
import {assertAccountAuthorization} from "@/platform/authz/current-authority";
import {authorize} from "@/platform/authz/authorize";
import {captureAuthorizationCap,restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {explicitNotificationRoutingSchema} from "@/platform/notifications/notification-routing";
import {LeadRepository} from "@/modules/crm/infrastructure/lead-repository";
import {LeadWorkRepository} from "@/modules/crm/infrastructure/lead-work-repository";
import {leadWorkPolicyKey,leadWorkPolicySchema} from "@/modules/crm/domain/lead-work";
import {LeadAccessError,leadCapturePolicyKey,leadCapturePolicySchema} from "@/modules/crm/domain/lead-capture";
import {leadResource} from "@/modules/crm/application/lead-resource";

export const leadReminderRoutingKey="notification.routing.lead_reminder";
export type LeadReminderResource=ReturnType<typeof leadResource>&{notificationEventId:string;leadWorkRecipientId:string};

/** Identifier-only notices always resolve the current native reminder and both actors' current grants. */
export async function leadReminderContext(tx:TenantTransaction,organizationId:string,id:string,recipientId?:string){
  const now=await new LeadRepository(tx,organizationId).clock(),repository=new LeadWorkRepository(tx,organizationId),row=await repository.reminder(id,now);
  if(!row?.recipientId||recipientId&&row.recipientId!==recipientId)return null;
  const config=new ConfigRuleRepository(tx,organizationId),scopes=[{scopeType:"organization" as const,scopeId:null}],work=await config.resolve({key:leadWorkPolicyKey,scopes,asOf:now}),capture=await config.resolve({key:leadCapturePolicyKey,scopes,asOf:now}),route=await config.resolve({key:leadReminderRoutingKey,scopes,asOf:now});
  if(!work||!capture||!route)return null;
  const resource=leadResource(row.lead,row.lead.stageRevisions[0]?.toStage??row.lead.initialStage,row.lead.workEntries[0]??null);
  try{
    leadWorkPolicySchema.parse(work.parsedValue);leadCapturePolicySchema.parse(capture.parsedValue);
    const routing=explicitNotificationRoutingSchema.parse(route.parsedValue),held=restoreAuthorizationCap(row.authorizationCap),stored=await authContextForAccountInTransaction(tx,organizationId,row.createdBy),actor={organizationId,actorId:row.createdBy,authContext:held};
    assertAccountAuthorization(actor,stored,now,[{action:"view",resource},{action:"edit",resource}],new LeadAccessError());
    const recipient=await repository.account(row.recipientId);if(!recipient)return null;
    const state=await new IdentityRepository(tx,organizationId).authorizationState(recipient.id);if(!state.account||securityEnrollment(state.account,state.now).setupRequired)return null;
    const assignments=routing.people.includes(recipient.personId)?state.assignments:state.assignments.filter(assignment=>routing.roles.includes(assignment.role.id)),authority={...contextForRoleAssignments(organizationId,recipient.id,assignments),personId:recipient.personId};if(!authorize(authority,"view",resource,state.now))return null;
    const target:LeadReminderResource={...resource,notificationEventId:row.id,leadWorkRecipientId:row.recipientId},fingerprint=commandFingerprint({entryId:row.id,payloadSha256:row.payloadSha256,stageId:row.lead.stageRevisions[0]?.id??null,assignmentId:row.lead.workEntries[0]?.id??null,work:{id:work.id,version:work.version,value:work.value},capture:{id:capture.id,version:capture.version,value:capture.value},routing:{id:route.id,version:route.version,value:route.value},creator:captureAuthorizationCap(stored),recipient:captureAuthorizationCap(authority)});
    return{row,now,target,routing,fingerprint};
  }catch(error){if(error instanceof LeadAccessError||error instanceof ZodError)return null;throw error;}
}
