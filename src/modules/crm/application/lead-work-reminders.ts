import {randomUUID} from "node:crypto";
import {authorize} from "@/platform/authz/authorize";
import {prisma} from "@/platform/db/client";
import {withTenant,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {NotificationRepository} from "@/platform/notifications/notification-repository";
import {publishNotifications} from "@/platform/notifications/notification-service";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {LeadRepository} from "../infrastructure/lead-repository";
import {LeadWorkRepository} from "../infrastructure/lead-work-repository";
import {leadWorkPolicyKey,LeadWorkConflictError} from "../domain/lead-work";
import {leadCapturePolicyKey} from "../domain/lead-capture";
import {leadReminderContext,leadReminderRoutingKey} from "@/platform/notifications/lead-work-source";

type Deps={db?:TenantTransactionRunner;requestId?:string};
/** The existing durable notification publisher owns delivery, channels and preference enforcement. */
export async function scheduleLeadWorkReminders(organizationId:string,deps:Deps={}){
  const db=deps.db??prisma;let before:string|undefined,notificationsRequested=0;
  for(;;){
    const candidates=await withTenant(db,organizationId,async tx=>new LeadWorkRepository(tx,organizationId).dueReminders(await new LeadRepository(tx,organizationId).clock(),before)),batch=candidates.slice(0,100);
    for(const candidate of batch)notificationsRequested+=await withTenant(db,organizationId,async tx=>{
      const config=new ConfigRuleRepository(tx,organizationId);for(const key of[leadCapturePolicyKey,leadWorkPolicyKey,leadReminderRoutingKey].sort())await config.lockVersion(key,"organization",null);
      const repository=new LeadWorkRepository(tx,organizationId);await repository.lockLead(candidate.leadId);
      const key="crm.lead.reminder:"+candidate.id;if(await new OutboxRepository(tx,organizationId).byIdempotencyKey(key))return 0;
      const source=await leadReminderContext(tx,organizationId,candidate.id);if(!source)return 0;
      const notifications=new NotificationRepository(tx,organizationId),recipient=await notifications.explicitRecipientContext(source.row.recipientId!,source.routing);if(!recipient||!authorize(recipient,"view",source.target,source.now))return 0;
      await publishNotifications(tx,organizationId,[{key,occurredAt:source.now,input:{kind:"lead_reminder",recipientId:source.row.recipientId!,targetId:source.row.id}}]);
      await writeAuditEvent(tx,{organizationId,actorId:null,action:"crm.lead_work_reminded",resourceType:"lead",resourceId:source.row.leadId,after:{entryId:source.row.id,subjectId:source.row.subjectId,recipientId:source.row.recipientId,sourceFingerprint:source.fingerprint},requestId:deps.requestId??randomUUID(),occurredAt:source.now});
      const final=await leadReminderContext(tx,organizationId,candidate.id);if(!final||final.fingerprint!==source.fingerprint)throw new LeadWorkConflictError();return 1;
    });
    if(candidates.length<=100)break;before=batch[99].id;
  }
  return{notificationsRequested};
}

export async function tickLeadWorkReminders(organizationId:string,deps:Deps={}){try{return{...await scheduleLeadWorkReminders(organizationId,deps),blocked:null};}catch(error){if(error instanceof LeadWorkConflictError)return{notificationsRequested:0,blocked:"source_changed" as const};throw error;}}
