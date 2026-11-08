import {randomBytes,randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeLeadArchiveFixture} from "./lead-document-fixture";
import {reviewDocumentTemplate,admitDocumentTemplate} from "@/modules/documents/application/document-template-authoring";
import {completeDocumentParts} from "@/modules/documents/application/document-archive";
import {reviewDocumentGeneration} from "@/modules/documents/application/document-generation-review";
import {admitDocumentGeneration} from "@/modules/documents/application/document-generation-admission";
import {executeDocumentGenerationReference} from "@/modules/documents/application/document-generation-worker";
import {documentGenerationRequested} from "@/modules/documents/domain/document-generation";
import type {DocumentObjectStore} from "@/modules/documents/infrastructure/document-object-store";
import {reviewNativeSignature,admitNativeSignature} from "@/modules/documents/application/document-signature-draft";
import {authContextForAccount} from "@/platform/authz/account-context";
import {DocumentRepository} from "@/modules/documents/infrastructure/document-repository";
import {reviewSignaturePreparation,admitSignaturePreparation,signaturePreparationOutboxKey} from "@/modules/documents/application/document-signature-preparation";
import {executeSignaturePreparationReference} from "@/modules/documents/application/document-signature-preparation-worker";
import {reviewSignatureDistribution,admitSignatureDistribution,signatureDistributionOutboxKey} from "@/modules/documents/application/document-signature-distribution";
import {executeSignatureDistributionReference} from "@/modules/documents/application/document-signature-distribution-worker";
import {receiveSignatureWebhook,signatureWebhookOutboxKey} from "@/modules/documents/application/document-signature-webhook";
import {executeSignatureWebhookReference} from "@/modules/documents/application/document-signature-webhook-worker";
import {ownedSignatureProvider} from "./document-signature-provider";

export function nativeLeadContractFixtures({admin,db,env,objects,organizations,providers}:{admin:PrismaClient;db:PrismaClient;env:NodeJS.ProcessEnv;objects:()=>DocumentObjectStore;organizations:string[];providers:Array<Awaited<ReturnType<typeof ownedSignatureProvider>>>}){
async function fixture(typeKey="management_contract",existing?:Awaited<ReturnType<typeof nativeLeadArchiveFixture>>){
 const f=existing??await nativeLeadArchiveFixture(admin,db,env,typeKey);organizations.push(f.organizationId);const variants=[];for(const locale of["en","fr"]as const){const draft={documentId:null,source:{kind:"ORGANIZATION",id:f.organizationId},typeKey,title:"Actual approved native contract "+locale,supersedesId:null,effectiveFrom:null,definition:{schemaVersion:1,templateKey:existing&&typeKey!=="management_contract"?"native_"+typeKey:"native_management_contract",locale,title:"{{lead_owner_contact}}",variables:[{key:"lead_owner_contact",kind:"TEXT"},{key:"lead_email",kind:"TEXT"}],blocks:[{kind:"PARAGRAPH",text:"{{lead_owner_contact}} / {{lead_email}}"}]}},review=await reviewDocumentTemplate(f.ctx,draft,{db,env}),admitted=await admitDocumentTemplate(f.ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual approved original contract language"},{db,env}),complete=await completeDocumentParts(f.ctx,{admissionId:admitted.id},{db,env,objects:objects()});expect(complete.version?.id).toBeTruthy();variants.push({locale,id:complete.version!.id});}
 const generationDraft={templateVersionId:variants.find(row=>row.locale==="fr")!.id,variantVersionIds:variants.map(row=>row.id),source:{kind:"LEAD",id:f.lead.id},title:"Actual reviewed native acquisition contract",effectiveFrom:null},review=await reviewDocumentGeneration(f.ctx,generationDraft,{db,env}),generation=await admitDocumentGeneration(f.ctx,{...generationDraft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual durable native acquisition contract PDF"},{db,env}),event=await withTenant(db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:documentGenerationRequested,payload:{path:["instanceId"],equals:generation.id}}})),complete=await executeDocumentGenerationReference({organizationId:f.organizationId,outboxEventId:event.id},{db,env,objects:objects()});expect(complete.state).toBe("COMPLETE");
 return{...f,instanceId:generation.id,versionId:complete.versionId!,draft:{instanceId:generation.id,documentVersionId:complete.versionId!,recipients:[{kind:"LEAD" as const,id:f.lead.id}]}};
}

type Fixture=Awaited<ReturnType<typeof fixture>>;

async function admit(f:Fixture){const review=await reviewNativeSignature(f.ctx,f.draft,{db,env}),command={...f.draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed native lead contract signer"},saved=await admitNativeSignature(f.ctx,command,{db,env});return{review,command,saved};}

async function reference(organizationId:string,key:string){
 const event=await withTenant(db,organizationId,tx=>tx.outboxEvent.findUniqueOrThrow({where:{organizationId_idempotencyKey:{organizationId,idempotencyKey:key}}}));
 return{organizationId,outboxEventId:event.id};
}

async function providerFixture(existing?:Awaited<ReturnType<typeof nativeLeadArchiveFixture>>){
 const f=await fixture("management_contract",existing),signature=await admit(f),http=await ownedSignatureProvider();providers.push(http);
 const editGrant=await withTenant(db,f.organizationId,async tx=>{
  const role=await tx.role.create({data:{organizationId:f.organizationId,key:"native_contract_delivery_"+randomUUID(),name:"Independent native contract delivery"}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"signature:edit"}});
  await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});
  const assignment=await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"documents.signatures",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Owned technical native Lead provider fixture; no legal acceptance claim",value:{source:"NATIVE_DOCUMENT_SIGNATURES",provider:"DOCUMENSO",enabled:true,
   account:{origin:http.origin,teamId:http.teamId,scopeEnvelopeId:http.scopeEnvelopeId,scopeReference:http.scopeReference},legal:{signatureLevel:"owned technical fixture only",ownerDecisionReference:"owned legal decision fixture",certificateDecisionReference:"owned certificate decision fixture"},
   signing:{order:"SEQUENTIAL",methods:{typed:true,draw:false,upload:false},delivery:{expiration:{unit:"day",amount:17},reminders:{sendAfter:{disabled:true},repeatEvery:{disabled:true}},emailSettings:{recipientSigningRequest:true,recipientRemoved:false,recipientSigned:false,documentPending:false,documentCompleted:true,documentDeleted:false,ownerDocumentCompleted:true,ownerRecipientExpired:true,ownerDocumentCreated:false}}}}});
  return assignment.id;
 });
 const ctx={...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},row=await withTenant(db,f.organizationId,tx=>new DocumentRepository(tx,f.organizationId).signature(signature.saved.id));if(!row)throw Error("Actual admitted native Lead signature required");
 const deps={db,env:{...env,DOCUMENSO_WEBHOOK_SECRET:randomBytes(32).toString("base64url")},objects:objects(),provider:http.provider,providerOrigin:http.origin},draft={signatureId:row.id,recipients:row.recipients.map(recipient=>({recipientId:recipient.id,role:"SIGNER" as const,signingOrder:1,fields:[{type:"SIGNATURE" as const,page:1,positionX:10,positionY:80,width:30,height:5}]}))},review=await reviewSignaturePreparation(ctx,draft,deps),command={...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Prepare the exact original native acquisition contract"},receipt=await admitSignaturePreparation(ctx,command,deps);
 return{...f,ctx,http,deps,editGrant,signature,preparation:{receipt,command,reference:await reference(f.organizationId,signaturePreparationOutboxKey(ctx.actorId,receipt.idempotencyKey))}};
}

type ProviderFixture=Awaited<ReturnType<typeof providerFixture>>;

async function prepareAndSend(f:ProviderFixture){
 expect((await executeSignaturePreparationReference(f.preparation.reference,f.deps)).state).toBe("PREPARED");
 const draft={preparationId:f.preparation.receipt.id},review=await reviewSignatureDistribution(f.ctx,draft,f.deps),command={...draft,delivery:"EMAIL" as const,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Send the explicitly reviewed original Lead contract"},receipt=await admitSignatureDistribution(f.ctx,command,f.deps),sendReference=await reference(f.organizationId,signatureDistributionOutboxKey(f.ctx.actorId,receipt.idempotencyKey));
 expect((await executeSignatureDistributionReference(sendReference,f.deps)).state).toBe("SENT");
 return{command,receipt,reference:sendReference};
}

async function callback(f:ProviderFixture,event:"DOCUMENT_OPENED"|"DOCUMENT_COMPLETED"){
 const prepared=await withTenant(db,f.organizationId,tx=>tx.signatureProviderEvidence.findFirstOrThrow({where:{signatureId:f.signature.saved.id,kind:"PREPARED"}}));if(!prepared.providerRequestId)throw Error("Actual acknowledged native provider identity required");
 const actual=await f.http.provider.readSignatureRequest({requestId:prepared.providerRequestId,reference:f.signature.saved.id}),bytes=new TextEncoder().encode(JSON.stringify({event,createdAt:new Date().toISOString(),payload:{envelopeId:prepared.providerRequestId,externalId:f.signature.saved.id,source:"DOCUMENT",status:actual.status,completedAt:f.http.state.lifecycle.completedAt??null,
  recipients:actual.recipients.map(recipient=>({id:recipient.id,envelopeId:prepared.providerRequestId,role:recipient.role,readStatus:recipient.readStatus,signingStatus:recipient.signingStatus,sendStatus:recipient.sendStatus,signedAt:recipient.signedAt,expiresAt:recipient.expiresAt}))}})),receipt=await receiveSignatureWebhook({organizationId:f.organizationId,providerScopeHash:prepared.providerScopeHash},f.deps.env.DOCUMENSO_WEBHOOK_SECRET,bytes,f.deps),work=await reference(f.organizationId,signatureWebhookOutboxKey(receipt.id));
 expect((await executeSignatureWebhookReference(work,f.deps)).state).toBe("RECORDED");return{receipt,reference:work};
}
return{fixture,admit,reference,providerFixture,prepareAndSend,callback};
}
