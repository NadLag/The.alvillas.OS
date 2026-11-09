import {randomUUID} from "node:crypto";

import type {PrismaClient} from "@prisma/client";

import {expect,type Page,type TestInfo} from "@playwright/test";

import {withTenant} from "@/platform/db/tenant";

import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";

import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";

import {documentTemplateMediaType} from "@/modules/documents/domain/document-template-format";

import {nativeLeadInput,appendNativeLeadFinancialSentinel} from "../../integration/support/lead-fixture";

import {configuredLeadWorkspace} from "./crm-fixtures";

import {e2eEmail,ensureE2EAdmin,completeE2EAdminMfa,waitForE2EAdminLoginWindow} from "./auth";

type Locale="en"|"fr"|"ar";

export const nativeLeadBrowserFinancial=(db:PrismaClient)=>db.$queryRaw`SELECT 'journal' AS kind,id::text,xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t UNION ALL SELECT 'posting',id::text,xmin::text,md5(to_jsonb(t)::text) FROM posting t ORDER BY kind,id`;

export async function nativeLeadDocumentBrowserFixture(page:Page,db:PrismaClient,locale:Locale,info:TestInfo,typeKey="acquisition_proposal",permissions:readonly string[]=[]){
 await appendNativeLeadFinancialSentinel(db,db);await configuredLeadWorkspace(db,bootstrapOrganizationId);
 const email=e2eEmail("lead-proposal-"+locale+"-"+randomUUID().slice(0,8),info.project.name),password=process.env.ADMIN_PASSWORD??"correct horse battery staple";await ensureE2EAdmin(email,password);
 await page.goto("/en/login");await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);await page.getByTestId("login-submit").click();await completeE2EAdminMfa(page,email);await expect(page).toHaveURL(/\/en\/app/u);
 const saved=await withTenant(db,bootstrapOrganizationId,async tx=>{
  const account=await tx.userAccount.findFirstOrThrow({where:{email}}),organization=await tx.organization.findFirstOrThrow({where:{id:bootstrapOrganizationId}}),grants:Record<string,string>={};await tx.roleAssignment.updateMany({where:{userAccountId:account.id,validTo:null},data:{validTo:new Date()}});
  for(const key of["lead:create","lead:view","lead:edit","lead:export","document:view","document:create","document:edit","document:export","document_template:view","document_template:create","document_template:edit","document_template:export","document_instance:view","document_instance:create","document_instance:edit","document_instance:export","organization:view","organization:export",...permissions]){
   const role=await tx.role.create({data:{organizationId:bootstrapOrganizationId,key:"actual_proposal_ui_"+randomUUID(),name:"Independent native proposal "+key}}),permission=await tx.permission.findFirstOrThrow({where:{key}});await tx.rolePermission.create({data:{organizationId:bootstrapOrganizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:bootstrapOrganizationId,userAccountId:account.id,personId:account.personId,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});grants[key]=assignment.id;
  }
  await new ConfigRuleRepository(tx,bootstrapOrganizationId).createVersion({key:"documents.archive",scopeType:"organization",createdBy:account.id,effectiveFrom:new Date("2020-01-01"),reason:"Explicit approved private acquisition proposal browser policy",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:30,upload_admission:{window_seconds:3600,max_requests:100},upload_transport:{window_seconds:3600,max_requests:100},types:[{key:typeKey,labels:typeKey==="management_contract"?{en:"Management contract",fr:"Contrat de gestion",ar:"عقد إدارة"}:{en:"Acquisition proposal",fr:"Proposition d’acquisition",ar:"عرض الاستحواذ"},sources:["ORGANIZATION","LEAD"],privacy:["sensitive"],content_types:[documentTemplateMediaType,"application/pdf"],max_bytes:1048576}]}});return{account,organization,grants};
 });
 const scope=bootstrapOrganizationId+"."+saved.account.id,origin=new URL(page.url()).origin,headers={Origin:origin,"x-alvillas-document-scope":scope},marker="Native owner "+randomUUID(),owner=marker+" LongContact".repeat(9),input={...nativeLeadInput(),locale,fields:{...nativeLeadInput().fields,ownerContact:owner}},capture=await page.request.post("/api/crm/leads/capture",{headers:{Origin:origin,"x-alvillas-crm-scope":scope},data:input});expect(capture.status()).toBe(200);const lead=await capture.json() as {id:string};
 await page.goto(`/${locale}/app/crm?lead=${lead.id}`);await expect(page.getByTestId("lead-current-details")).toContainText(owner);return{...saved,scope,headers,lead,input,marker,owner};
}

export async function nativeLeadDocumentBrowserTemplates(page:Page,f:Awaited<ReturnType<typeof nativeLeadDocumentBrowserFixture>>,typeKey="acquisition_proposal"){
 const variants=[];for(const locale of["en","fr"]as const){const draft={documentId:null,source:{kind:"ORGANIZATION",id:bootstrapOrganizationId},typeKey,title:"Native approved "+locale+(typeKey==="management_contract"?" contract ":" proposal ")+f.marker,supersedesId:null,effectiveFrom:null,definition:{schemaVersion:1,templateKey:(typeKey==="management_contract"?"native_contract_":"native_acquisition_")+f.lead.id.replaceAll("-",""),locale,title:"{{source_label}}",variables:[{key:"source_label",kind:"TEXT"},{key:"lead_property_type",kind:"TEXT"}],blocks:[{kind:"PARAGRAPH",text:"{{source_label}} / {{lead_property_type}}"}]}},review=await page.request.post("/api/documents/templates/review",{headers:f.headers,data:draft});expect(review.status()).toBe(200);const checked=await review.json() as {reviewFingerprint:string},admit=await page.request.post("/api/documents/templates/admit",{headers:f.headers,data:{...draft,idempotencyKey:randomUUID(),reviewFingerprint:checked.reviewFingerprint,reason:"Explicit actual approved acquisition proposal language"}});expect(admit.status()).toBe(200);const receipt=await admit.json() as {id:string;documentId:string},complete=await page.request.post("/api/documents/complete",{headers:f.headers,data:{admissionId:receipt.id}});expect(complete.status()).toBe(200);variants.push({locale,documentId:receipt.documentId});}return variants;
}

export async function selectNativeLeadDocumentBrowserTemplates(page:Page,f:Awaited<ReturnType<typeof nativeLeadDocumentBrowserFixture>>,variants:Awaited<ReturnType<typeof nativeLeadDocumentBrowserTemplates>>){
 await page.getByTestId("generation-library-query").fill(f.organization.name);await page.getByTestId("generation-find-sources").click();await page.getByTestId("generation-library-source").filter({hasText:f.organization.name}).click();for(const variant of variants){await page.getByTestId(`generation-${variant.locale}-template`).selectOption(variant.documentId);const version=page.getByTestId(`generation-${variant.locale}-version`);await expect(version.locator("option")).toHaveCount(2);await version.selectOption({index:1});}
}

export async function privateNativeLeadBrowserStorage(page:Page){return page.evaluate(async()=>{const bodies:string[]=[];for(const name of await caches.keys()){const cache=await caches.open(name);for(const request of await cache.keys()){const response=await cache.match(request);if(response?.headers.get("content-type")?.includes("application/json"))bodies.push(await response.text());}}return JSON.stringify({local:{...localStorage},session:{...sessionStorage},bodies});});}
