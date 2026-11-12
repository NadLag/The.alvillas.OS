import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {OutboxEvent} from "@prisma/client";
import {z} from "zod";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {restoreAuthorizationCap} from "@/platform/authz/authorization-cap";
import {onboardingOwnerEmailEvent} from "@/platform/events/onboarding-owner-email";
import {OutboxRepository} from "@/platform/events/outbox-repository";
import {DeliveryRepository} from "./delivery-repository";
import {nativeOnboardingOwnerDeliveryOriginal,onboardingOwnerDeliveryOutboxKey} from "@/modules/onboarding/application/onboarding-owner-delivery-service";
import {prepareOnboardingOwnerDelivery} from "@/modules/onboarding/application/onboarding-owner-delivery-preparation";
import {OnboardingOwnerDeliveryRepository} from "@/modules/onboarding/infrastructure/onboarding-owner-delivery-repository";
import {OnboardingAccessError,OnboardingConflictError} from "@/modules/onboarding/domain/onboarding-wizard";
import {downloadOwnerDeliveryDocument} from "@/platform/documents/owner-delivery-documents";
import {configuredDocumentObjects} from "@/modules/documents/application/document-files";
import type {DocumentObjectStore} from "@/modules/documents/infrastructure/document-object-store";
import type {EmailProvider} from "@/platform/providers";
import {DocumentAccessError,DocumentConflictError} from "@/modules/documents/domain/document-command";

type Dependencies={db:TenantTransactionRunner;env:NodeJS.ProcessEnv;objects?:DocumentObjectStore;requestId?:string};
const payload=z.object({channel:z.literal("email"),ownerDeliveryId:z.uuid(),kind:z.literal("onboarding.owner_package")}).strict();
async function reference(tx:TenantTransaction,event:Pick<OutboxEvent,"organizationId"|"id">){
 const stored=await new OutboxRepository(tx,event.organizationId).event(event.id);if(!stored||stored.type!==onboardingOwnerEmailEvent||stored.status==="FAILED")throw new OnboardingAccessError();
 const input=payload.parse(stored.payload),row=await new OnboardingOwnerDeliveryRepository(tx,event.organizationId).byEmailEvent(stored.id);
 if(!row||input.ownerDeliveryId!==row.id||stored.idempotencyKey!==onboardingOwnerDeliveryOutboxKey(row.createdBy,row.commandKey)||stored.occurredAt.getTime()!==row.createdAt.getTime())throw new OnboardingAccessError();
 const cap=restoreAuthorizationCap(row.authorizationCap);if(cap.organizationId!==row.organizationId||cap.userAccountId!==row.createdBy)throw new OnboardingAccessError();
 return{stored,row,actor:{organizationId:row.organizationId,actorId:row.createdBy,authContext:cap}};
}
async function current(tx:TenantTransaction,event:Pick<OutboxEvent,"organizationId"|"id">,deps:Dependencies){
 const resolved=await reference(tx,event),runner:TenantTransactionRunner={$transaction:work=>work(tx)},local={db:runner,env:deps.env,requestId:deps.requestId},saved=await nativeOnboardingOwnerDeliveryOriginal(resolved.actor,tx,resolved.row.id,local),prepared=await prepareOnboardingOwnerDelivery(resolved.actor,{packageId:resolved.row.packageId},local);
 if(!isDeepStrictEqual(prepared.source,saved.original.source)||!isDeepStrictEqual(prepared.policySnapshot,saved.original.policySnapshot)||prepared.owner.xmin!==saved.original.metadata.ownerVersion||prepared.owner.tuple!==saved.original.metadata.ownerTuple)throw new OnboardingConflictError();
 const selected=saved.original.emails.find(email=>email.locale===saved.row.locale);if(!selected)throw new OnboardingConflictError();return{...resolved,...saved,selected};
}
/** Original archive/storage I/O occurs before the canonical delivery transactions and never reconstructs email content. */
export async function captureOnboardingOwnerEmail(event:OutboxEvent,deps:Dependencies){
 const capture=await withTenant(deps.db,event.organizationId,async tx=>{await reference(tx,event);const delivery=await new DeliveryRepository(tx,event.organizationId).byEmailEvent(event.id);if(delivery&&delivery.status!=="PENDING")return{terminal:true as const};return{terminal:false as const,value:await current(tx,event,deps)};},{timeout:120000});
 if(capture.terminal)return capture;const original=capture.value,objects=deps.objects??configuredDocumentObjects(),attachments:NonNullable<Parameters<EmailProvider["send"]>[0]["attachments"]>[number][]=[];
 for(const document of original.original.documentPlan){const file=await downloadOwnerDeliveryDocument(original.actor,{versionId:document.versionId},{db:deps.db,env:deps.env,objects,requestId:deps.requestId});if(file.bytes.length!==document.byteSize||createHash("sha256").update(file.bytes).digest("hex")!==document.sha256)throw new OnboardingConflictError();attachments.push({filename:"owner-package-"+document.locale+".pdf",content:Buffer.from(file.bytes).toString("base64"),contentType:"application/pdf"});}
 const final=await withTenant(deps.db,event.organizationId,tx=>current(tx,event,deps),{timeout:120000});if(final.row.commandHash!==original.row.commandHash||final.row.sourceFingerprint!==original.row.sourceFingerprint||!isDeepStrictEqual(final.original.documentPlan,original.original.documentPlan))throw new OnboardingConflictError();
 return{terminal:false as const,ownerDeliveryId:original.row.id,commandHash:original.row.commandHash,sourceFingerprint:original.row.sourceFingerprint,email:{...original.selected,attachments}};
}
export type OnboardingOwnerEmailCapture=Awaited<ReturnType<typeof captureOnboardingOwnerEmail>>;
export function onboardingOwnerEmailFailure(error:unknown):{status:"SUPPRESSED"|"FAILED";code:"preferences_or_access_changed"|"content_or_recipient_changed"|"provider_not_configured"}{
 if(error instanceof OnboardingAccessError||error instanceof DocumentAccessError)return{status:"SUPPRESSED",code:"preferences_or_access_changed"};
 if(error instanceof OnboardingConflictError||error instanceof DocumentConflictError)return{status:"SUPPRESSED",code:"content_or_recipient_changed"};
 return{status:"FAILED",code:"provider_not_configured"};
}

/** Recheck current plus held creation/export authority at each canonical send phase; this performs metadata reads only. */
export async function validateOnboardingOwnerEmail(tx:TenantTransaction,event:OutboxEvent,capture:OnboardingOwnerEmailCapture,deps:Dependencies){
 if(capture.terminal)throw new OnboardingConflictError();const actual=await current(tx,event,deps);
 if(actual.row.id!==capture.ownerDeliveryId||actual.row.commandHash!==capture.commandHash||actual.row.sourceFingerprint!==capture.sourceFingerprint||!isDeepStrictEqual(actual.selected,{to:capture.email.to,subject:capture.email.subject,html:capture.email.html,text:capture.email.text,locale:capture.email.locale,template:capture.email.template}))throw new OnboardingConflictError();
 return capture.email;
}
