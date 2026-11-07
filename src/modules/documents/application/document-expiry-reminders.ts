import { randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";
import { prisma } from "@/platform/db/client";
import { withTenant, type TenantTransaction, type TenantTransactionRunner } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { authContextForAccountInTransaction } from "@/platform/authz/account-context";
import { recheckAccountAuthorization } from "@/platform/authz/current-authority";
import { captureAuthorizationCap } from "@/platform/authz/authorization-cap";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { publishNotifications } from "@/platform/notifications/notification-service";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { commandFingerprint } from "@/platform/http/command-fingerprint";
import { DocumentExpiryRepository } from "../infrastructure/document-expiry-repository";
import { documentExpiryPolicyKey, documentExpiryRoutingKey, documentExpiryOccurrence } from "../domain/document-expiry-policy";
import { DocumentAccessError, DocumentConfigurationError, DocumentConflictError } from "../domain/document-command";
import { documentJson } from "./document-archive";
import { documentExpiryContext } from "./document-expiry-service";
import { documentExpiryNoticeTarget, documentExpiryReminderSettings } from "./document-expiry-notification";

type Deps={db?:TenantTransactionRunner;requestId?:string;env?:NodeJS.ProcessEnv};
const result=(configured:boolean)=>({configured,occurrences:0,notificationsRequested:0});
async function principal(tx:TenantTransaction,organizationId:string,principalId:string,now:Date){
  const ctx={organizationId,actorId:principalId,authContext:await authContextForAccountInTransaction(tx,organizationId,principalId)};
  await recheckAccountAuthorization(ctx,tx,now,[{action:"configure",resource:{type:"config_rule",organizationId},organizationOnly:true}],new DocumentAccessError());
  return ctx;
}

/** Bounded scans avoid re-authorizing occurrences already durably recorded. Each new occurrence has its own transaction. */
export async function scheduleDocumentExpiryReminders(organizationId:string,deps:Deps={}){
  const db=deps.db??prisma,totals=result(false);let before:string|undefined;
  for(;;){
    const page=await withTenant(db,organizationId,async tx=>{
      const repository=new DocumentExpiryRepository(tx,organizationId),now=await repository.clock(),settings=await documentExpiryReminderSettings(tx,organizationId,now);
      if(!settings)return null;
      await principal(tx,organizationId,settings.principalId,now);
      const until=Temporal.PlainDate.from(settings.on).subtract({days:settings.policy.stages[0].offset_days}).toString();
      const candidates=await repository.expiryCandidates(settings.policy.type_keys,new Date(until+"T00:00:00.000Z"),before),bounded=candidates.slice(0,100);
      const occurrences=bounded.flatMap(row=>{if(!row.expiresOn)return[];const occurrence=documentExpiryOccurrence(settings.policy,{revisionId:row.id,policyId:settings.policySnapshot.id,on:settings.on,dueOn:row.expiresOn.toISOString().slice(0,10),localTime:settings.localTime});return occurrence?[{row,key:occurrence.idempotencyKey}]:[];});
      const existing=await repository.existingExpiryOccurrences(occurrences.map(item=>item.key));
      return{candidates:occurrences.filter(item=>!existing.has(item.key)).map(item=>item.row),next:candidates.length>100?bounded[99].id:undefined};
    });
    if(!page)return totals;totals.configured=true;
    for(const candidate of page.candidates){
      const prepared=await withTenant(db,organizationId,async tx=>{
        const repository=new DocumentExpiryRepository(tx,organizationId),rules=new ConfigRuleRepository(tx,organizationId);
        for(const key of[documentExpiryPolicyKey,documentExpiryRoutingKey].sort())await rules.lockVersion(key,"organization",null);
        await repository.lock("expiry:"+candidate.versionId);
        const now=await repository.clock(),settings=await documentExpiryReminderSettings(tx,organizationId,now);if(!settings)return result(false);
        const ctx=await principal(tx,organizationId,settings.principalId,now),revision=await repository.currentExpiry(candidate.versionId);
        if(!revision?.expiresOn||revision.id!==candidate.id)return result(true);
        const occurrence=documentExpiryOccurrence(settings.policy,{revisionId:revision.id,policyId:settings.policySnapshot.id,on:settings.on,dueOn:revision.expiresOn.toISOString().slice(0,10),localTime:settings.localTime});
        if(!occurrence)return result(true);await repository.lock(occurrence.idempotencyKey);if(await repository.expiryReminderByKey(occurrence.idempotencyKey))return result(true);
        const source=await documentExpiryContext(ctx,tx,revision.versionId,deps).catch(error=>{if(error instanceof DocumentAccessError)return null;throw error;});
        if(!source)return result(true);
        if(source.archive.native.archived||source.root.archivedAt||source.archive.signedArtifact||!settings.policy.type_keys.includes(source.root.typeKey)||(await repository.effectiveVersion(source.root.id,now))?.id!==source.version.id)return result(true);
        const notifications=new NotificationRepository(tx,organizationId),eligible=await notifications.viewers(settings.routing,source.archive.native.resource),recipients:string[]=[],authorizationSnapshots:Record<string,unknown>={};
        for(const recipientId of eligible){
          const authority=await notifications.explicitRecipientContext(recipientId,settings.routing);if(!authority)continue;
          try{await documentExpiryContext({organizationId,actorId:recipientId,authContext:authority},tx,revision.versionId,deps);}catch(error){if(error instanceof DocumentAccessError)continue;throw error;}
          recipients.push(recipientId);authorizationSnapshots[recipientId]=captureAuthorizationCap(authority);
        }
        if(!recipients.length)return result(true);
        const id=randomUUID(),sourceSnapshot={documentId:source.root.id,versionId:source.version.id,revisionId:revision.id,expiresOn:revision.expiresOn.toISOString().slice(0,10),timezone:settings.timezone},eventIds=recipients.map(()=>randomUUID());
        const commandHash=commandFingerprint({sourceSnapshot,sourceFingerprint:source.sourceFingerprint,policy:settings.policySnapshot,routing:settings.routingSnapshot,occurrence,recipients,authorizationSnapshots});
        await repository.appendExpiryReminder({id,revisionId:revision.id,principalId:settings.principalId,idempotencyKey:occurrence.idempotencyKey,commandHash,sourceFingerprint:source.sourceFingerprint,stageKey:occurrence.stage,occurredOn:new Date(occurrence.on+"T00:00:00.000Z"),policySnapshot:documentJson(settings.policySnapshot),routingSnapshot:documentJson(settings.routingSnapshot),sourceSnapshot:documentJson(sourceSnapshot),authorizationSnapshots:documentJson(authorizationSnapshots),recipientIds:recipients,outboxEventIds:eventIds,observedAt:now});
        await publishNotifications(tx,organizationId,recipients.map((recipientId,index)=>({eventId:eventIds[index],occurredAt:now,key:occurrence.idempotencyKey+":"+recipientId,input:{kind:"document_expiring",recipientId,targetId:id}})));
        await writeAuditEvent(tx,{organizationId,actorId:null,action:"documents.expiry_reminded",resourceType:"document",resourceId:source.root.id,after:{principalId:settings.principalId,reminderId:id,revisionId:revision.id,versionId:source.version.id,commandHash,sourceFingerprint:source.sourceFingerprint,notificationsRequested:recipients.length},reason:settings.reason,requestId:deps.requestId??randomUUID(),occurredAt:now});
        const finalNow=await repository.clock(),finalSettings=await documentExpiryReminderSettings(tx,organizationId,finalNow);
        if(!finalSettings||commandFingerprint({...settings,on:undefined,localTime:undefined})!==commandFingerprint({...finalSettings,on:undefined,localTime:undefined}))throw new DocumentConflictError();
        await principal(tx,organizationId,settings.principalId,finalNow);
        const finalSource=await documentExpiryContext(ctx,tx,revision.versionId,deps);
        if(finalSource.sourceFingerprint!==source.sourceFingerprint||finalSource.latest?.id!==revision.id)throw new DocumentConflictError();
        for(const recipientId of recipients)if(!await documentExpiryNoticeTarget(tx,organizationId,id,recipientId,deps.env))throw new DocumentAccessError();
        return{configured:true,occurrences:1,notificationsRequested:recipients.length};
      });
      totals.occurrences+=prepared.occurrences;totals.notificationsRequested+=prepared.notificationsRequested;
    }
    if(!page.next)return totals;before=page.next;
  }
}

/** An unavailable policy or principal must not stop the other dispatcher work. */
export async function tickDocumentExpiryReminders(organizationId:string,deps:Deps={}){
  try{return{...await scheduleDocumentExpiryReminders(organizationId,deps),blocked:null};}
  catch(error){if(error instanceof DocumentAccessError)return{...result(true),blocked:"authority_unavailable" as const};if(error instanceof DocumentConfigurationError)return{...result(true),blocked:"configuration_unavailable" as const};if(error instanceof DocumentConflictError)return{...result(true),blocked:"source_changed" as const};throw error;}
}
