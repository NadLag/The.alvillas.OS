import {randomUUID} from "node:crypto";
import type {PrismaClient} from "@prisma/client";
import {expect} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {reviewLeadStage,admitLeadStage} from "@/modules/crm/application/lead-stage-service";
import {leadConversionPolicyKey} from "@/modules/crm/domain/lead-conversion";
import {leadStages} from "@/modules/crm/domain/lead-pipeline";

import {documentArchivePolicySchema} from "@/modules/documents/domain/document-policy";
import {downloadDocumentVersion} from "@/modules/documents/application/document-archive";
import {SignedSignatureRepository} from "@/modules/documents/infrastructure/signed-signature-repository";
import {executeSignedArchiveReference} from "@/modules/documents/application/document-signed-archive-worker";
import {signedArchiveOutboxKey} from "@/modules/documents/application/document-signed-archive-admission";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import {createElement} from "react";
import {Document as PdfDocument,Page as PdfPage,Text as PdfText,renderToBuffer} from "@react-pdf/renderer";
import {nativeLeadArchiveFixture} from "./lead-document-fixture";
import type {nativeLeadContractFixtures} from "./lead-contract-fixture";

export const conversionPolicy={source:"NATIVE_REVIEWED_LEAD_OWNER_CONVERSION",history:"APPEND_ONLY_ORIGINAL_CONVERSION",prerequisite:"NATIVE_SIGNED_STAGE_AND_COMPLETED_ARCHIVE",modes:["CREATE","LINK"],admission:{requests:100,window_seconds:3600}};

export async function nativeLeadConversionFixture({admin,db,env,harness}:{admin:PrismaClient;db:PrismaClient;env:NodeJS.ProcessEnv;harness:ReturnType<typeof nativeLeadContractFixtures>}){
 const source=await nativeLeadArchiveFixture(admin,db,env,"management_contract");
 const grants=await withTenant(db,source.organizationId,async tx=>{
  const result:Record<string,string>={};for(const key of["owner:view","owner:create","owner:edit"]){const role=await tx.role.create({data:{organizationId:source.organizationId,key:"native_conversion_"+randomUUID(),name:"Independent actual acquisition "+key}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:source.organizationId,key}});await tx.rolePermission.create({data:{organizationId:source.organizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:source.organizationId,userAccountId:source.account.id,personId:source.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});result[key]=assignment.id;}
  const config=new ConfigRuleRepository(tx,source.organizationId),current=await config.resolve({key:"documents.archive",scopes:[{scopeType:"organization",scopeId:null}],asOf:new Date()});if(!current)throw Error("Actual approved archive policy required");const value=documentArchivePolicySchema.parse(current.parsedValue);await config.createVersion({key:"documents.archive",scopeType:"organization",createdBy:source.account.id,effectiveFrom:new Date("2020-01-01"),value:{...value,types:[...value.types,{...value.types[0],key:"acquisition_proposal"}]},reason:"Explicit actual proposal and contract types for signed native acquisition"});
  await config.createVersion({key:leadConversionPolicyKey,scopeType:"organization",createdBy:source.account.id,effectiveFrom:new Date("2020-01-01"),value:conversionPolicy,reason:"Explicit native technical conversion fixture; no hosted or legal acceptance claim"});return result;
 });
 const ctx={...source.ctx,authContext:{...await authContextForAccount(source.organizationId,source.account.id,{db}),personId:source.person.id}},f=await harness.providerFixture({...source,ctx});await harness.prepareAndSend(f);f.http.state.lifecycle.readStatus="OPENED";await harness.callback(f,"DOCUMENT_OPENED");
 const original=await downloadDocumentVersion(f.ctx,{versionId:f.versionId},f.deps),task=getDocument({data:new Uint8Array(original.bytes),useSystemFonts:false,useWorkerFetch:false,useWasm:false,disableFontFace:true,verbosity:0}),pages=[];
 try{const pdf=await task.promise;for(let number=1;number<=pdf.numPages;number++){const page=await pdf.getPage(number),box=page.getViewport({scale:1}),text=(await page.getTextContent()).items.map(item=>"str"in item?item.str:"").join(" ");pages.push(createElement(PdfPage,{key:number,size:[box.width,box.height]},createElement(PdfText,{style:{fontSize:8}},text),createElement(PdfText,{style:{fontSize:8}},"Owned native signed acquisition fixture; no legal acceptance claim")));}}finally{await task.destroy();}
 f.http.state.signedPdf=new Uint8Array(await renderToBuffer(createElement(PdfDocument,{},...pages)));f.http.state.certificatePdf=new Uint8Array(await renderToBuffer(createElement(PdfDocument,{},createElement(PdfPage,{size:"A4"},createElement(PdfText,{},"Owned actual native conversion certificate")))));f.http.state.lifecycle={status:"COMPLETED",readStatus:"OPENED",signingStatus:"SIGNED",signedAt:new Date().toISOString(),completedAt:new Date().toISOString()};await harness.callback(f,"DOCUMENT_COMPLETED");
 const archive=await withTenant(db,f.organizationId,tx=>new SignedSignatureRepository(tx,f.organizationId).signedArchiveForSignature(f.signature.saved.id));if(!archive)throw Error("Actual completed native contract archive required");expect((await executeSignedArchiveReference(await harness.reference(f.organizationId,signedArchiveOutboxKey(archive.id)),f.deps)).state).toBe("COMPLETE");
 const proposal=await harness.fixture("acquisition_proposal",{...source,ctx}),events=await withTenant(db,f.organizationId,tx=>tx.signatureEvent.findMany({where:{signatureId:f.signature.saved.id,state:{in:["SENT","VIEWED"]}}})),evidenceReferences=[{kind:"PROPOSAL_VERSION"as const,sourceId:proposal.versionId},{kind:"CONTRACT_VERSION"as const,sourceId:f.versionId},{kind:"SIGNATURE_SENT"as const,sourceId:events.find(event=>event.state==="SENT")!.id},{kind:"SIGNATURE_VIEWED"as const,sourceId:events.find(event=>event.state==="VIEWED")!.id},{kind:"SIGNATURE_SIGNED_ARCHIVE"as const,sourceId:archive.id}];
 let previousRevisionId:string|null=null;for(const toStage of leadStages.slice(1,9)){const edge=f.stagePolicy.transitions.find(edge=>edge.to===toStage&&edge.kind==="ADVANCE")!,draft={leadId:f.lead.id,previousRevisionId,toStage,evidenceReferences:evidenceReferences.filter(proof=>edge.evidence.includes(proof.kind))},review=await reviewLeadStage(ctx,draft,{db,env}),saved=await admitLeadStage(ctx,{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual ordered signed acquisition evidence before native conversion"},{db,env});previousRevisionId=saved.id;}
 const allGrants:Record<string,string>={...f.grants,"lead:edit":f.editAssignmentId,...grants};return{...f,ctx,grants:allGrants,archive,evidenceReferences,draft:{leadId:f.lead.id,profileRevisionId:null,signedStageId:previousRevisionId!,target:{mode:"CREATE"as const}}};
}
