import type { AuthContext } from "@/platform/authz/authorize";
import { restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import type { TenantTransaction } from "@/platform/db/tenant";
import { DocumentExpiryRepository } from "../infrastructure/document-expiry-repository";
import { documentExpiryContext } from "./document-expiry-service";
import { DocumentAccessError, DocumentConfigurationError } from "../domain/document-command";
import { canReadDocumentExpiryNotice, type DocumentExpiryNoticeResource } from "../domain/document-expiry-notification";
import { z } from "zod";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { explicitNotificationRoutingSchema } from "@/platform/notifications/notification-routing";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { documentExpiryPolicyKey, documentExpiryPolicySchema, documentExpiryRoutingKey, documentExpiryOccurrence } from "../domain/document-expiry-policy";
import { calendarDateAt } from "@/i18n/format";
import { requireCurrentTimezoneData } from "@/platform/time/timezone-data";
import { isDeepStrictEqual } from "node:util";

export async function documentExpiryReminderSettings(tx:TenantTransaction,organizationId:string,now:Date){
  const rules=new ConfigRuleRepository(tx,organizationId),scopes=[{scopeType:"organization",scopeId:null}];
  const rule=await rules.resolve({key:documentExpiryPolicyKey,scopes,asOf:now});if(!rule)return null;
  const routingRule=await rules.resolve({key:documentExpiryRoutingKey,scopes,asOf:now}),policy=documentExpiryPolicySchema.safeParse(rule.value),routing=explicitNotificationRoutingSchema.safeParse(routingRule?.value),calendar=await new DocumentExpiryRepository(tx,organizationId).expiryCalendar();
  if(!rule.createdBy||!policy.success||!routingRule||!routing.success||!calendar?.timezone)throw new DocumentConfigurationError();
  try{requireCurrentTimezoneData();new Intl.DateTimeFormat("en",{timeZone:calendar.timezone});}catch{throw new DocumentConfigurationError();}
  return{policy:policy.data,routing:routing.data,principalId:rule.createdBy,reason:rule.reason,timezone:calendar.timezone,
    policySnapshot:{id:rule.id,version:rule.version,value:policy.data},routingSnapshot:{id:routingRule.id,version:routingRule.version,value:routing.data},
    on:calendarDateAt(now,calendar.timezone),localTime:new Intl.DateTimeFormat("en-GB",{timeZone:calendar.timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now)};
}

export async function documentExpiryNoticeTarget(tx:TenantTransaction,organizationId:string,reminderId:string,recipientId:string,env?:NodeJS.ProcessEnv):Promise<DocumentExpiryNoticeResource|null>{
  const repository=new DocumentExpiryRepository(tx,organizationId),reminder=await repository.expiryReminder(reminderId);if(!reminder||!reminder.recipientIds.includes(recipientId))return null;
  const revision=await repository.expiryRevision(reminder.revisionId);if(!revision?.expiresOn||(await repository.currentExpiry(revision.versionId))?.id!==revision.id)return null;
  const snapshots=z.record(z.uuid(),z.json()).safeParse(reminder.authorizationSnapshots);if(!snapshots.success||!Object.hasOwn(snapshots.data,recipientId))return null;
  let settings:Awaited<ReturnType<typeof documentExpiryReminderSettings>>;
  try{settings=await documentExpiryReminderSettings(tx,organizationId,await repository.clock());}catch(error){if(error instanceof DocumentConfigurationError)return null;throw error;}
  if(!settings||!isDeepStrictEqual(settings.policySnapshot,reminder.policySnapshot)||!isDeepStrictEqual(settings.routingSnapshot,reminder.routingSnapshot))return null;
  const sourceSnapshot=z.object({timezone:z.string()}).passthrough().safeParse(reminder.sourceSnapshot);if(!sourceSnapshot.success||sourceSnapshot.data.timezone!==settings.timezone)return null;
  const occurrence=documentExpiryOccurrence(settings.policy,{revisionId:revision.id,policyId:settings.policySnapshot.id,on:settings.on,dueOn:revision.expiresOn.toISOString().slice(0,10),localTime:settings.localTime});
  if(!occurrence||occurrence.idempotencyKey!==reminder.idempotencyKey)return null;
  const current=await new NotificationRepository(tx,organizationId).explicitRecipientContext(recipientId,settings.routing);if(!current)return null;
  let held:AuthContext;try{held=restoreAuthorizationCap(snapshots.data[recipientId]);}catch{return null;}
  if(held.organizationId!==organizationId||held.userAccountId!==recipientId)return null;
  let original:Awaited<ReturnType<typeof documentExpiryContext>>|undefined;
  try{
    for(const authority of[current,held]){const view=await documentExpiryContext({organizationId,actorId:recipientId,authContext:authority},tx,revision.versionId,{env});if(view.archive.native.archived||view.root.archivedAt||view.archive.signedArtifact||(await repository.effectiveVersion(view.root.id,view.archive.now))?.id!==view.version.id)return null;original??=view;}
  }catch(error){if(error instanceof DocumentAccessError||error instanceof DocumentConfigurationError)return null;throw error;}
  if(!original)return null;
  const resource:DocumentExpiryNoticeResource={...original.archive.native.resource,type:"document",id:original.root.id,documentId:original.root.id,assignedUserAccountId:original.root.createdBy,dataClass:original.archive.privacy.includes("financial")?"financial":original.archive.privacy.includes("sensitive")?"sensitive":"operational",notificationEventId:reminder.id,documentExpiryAudienceId:recipientId,documentExpiryVersionNumber:original.version.number,documentExpiryChecks:original.archive.checks};
  return canReadDocumentExpiryNotice(current,resource,original.archive.now)&&canReadDocumentExpiryNotice(held,resource,original.archive.now)?resource:null;
}
