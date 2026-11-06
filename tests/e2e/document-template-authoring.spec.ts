import { randomUUID,createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect,test,type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { documentTemplateMediaType } from "@/modules/documents/domain/document-template-format";
import { decodeDocumentTemplate,documentTemplateVariantsSchema } from "@/modules/documents/domain/document-template";
import { openFieldFixture } from "./support/field-fixture";
import { acknowledgementBarrier } from "./support/acknowledgement-barrier";
import { forwardBrowserPostOnce } from "./support/forward-browser-post";

async function selectProperty(page:Page,name:string){
  await page.getByTestId("document-source-kind").selectOption("PROPERTY");await page.getByTestId("document-source-query").fill(name);
  const choice=page.getByTestId("document-source").filter({hasText:name});await expect(choice).toHaveCount(1);await choice.click();await page.getByTestId("document-kind").selectOption("TEMPLATE");await expect(page.getByTestId("document-template-editor")).toBeVisible();
}
async function fillDefinition(page:Page,options:{key:string;locale:string;title:string;heading:string;text:string;reason:string}){
  await page.getByTestId("template-archive-title").fill(options.title);await page.getByTestId("template-code").fill(options.key);await page.getByTestId("template-locale").selectOption(options.locale);await page.getByTestId("template-heading").fill(options.heading);
  await page.getByTestId("template-add-variable").click();await page.getByTestId("template-variable-key").fill("property");await page.getByTestId("template-variable-type").selectOption("TEXT");await page.getByTestId("template-section-text").fill(options.text);await page.getByTestId("template-reason").fill(options.reason);
}
async function saveDefinition(page:Page){
  const completion=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/documents/complete"&&response.request().method()==="POST");await page.getByTestId("template-save").click();const response=await completion;expect(response.status()).toBe(200);expect(await response.json()).toMatchObject({recorded:true,state:"COMPLETE",complete:true});await expect(page.getByTestId("document-recover")).toHaveCount(0);
}
for(const locale of ["en","fr","ar"] as const)test(`Authored template languages retain original text and recover server-held intents privately in ${locale}`,async({page},info)=>{
  test.skip(!process.env.DATABASE_URL,"Dedicated native PostgreSQL required");test.setTimeout(240000);
  const f=await openFieldFixture(page,info,locale),pageErrors:string[]=[];page.on("pageerror",error=>pageErrors.push(error.name));
  try{
    const fixture=await withTenant(f.db,f.organizationId,async tx=>{
      const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),property=await tx.property.findUniqueOrThrow({where:{id:task.propertyId}}),actorId=task.assignedToUserAccountId!;
      await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"documents.archive",scopeType:"property",scopeId:property.id,effectiveFrom:new Date("2020-01-01"),createdBy:actorId,reason:"Explicit authored template browser policy",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:30,upload_admission:{window_seconds:3600,max_requests:100},upload_transport:{window_seconds:3600,max_requests:100},
        types:[{key:"typed_agreement",labels:{en:"Authored agreement",fr:"Convention rédigée",ar:"اتفاقية محررة"},sources:["PROPERTY"],privacy:["financial"],content_types:[documentTemplateMediaType],max_bytes:262144}]}});return{property,actorId};
    });
    const suffix=randomUUID().replaceAll("-","").slice(0,12),key="authored_agreement_"+suffix,marker="PRIVATE-AUTHORED-"+suffix,title="Original authored template "+suffix,
      body=marker+" {{property}}. "+"a".repeat(17000),headers={Origin:new URL(page.url()).origin},storageKey="alvillas:document-upload:"+f.organizationId+"."+fixture.actorId;
    const money=()=>withTenant(f.db,f.organizationId,tx=>tx.$queryRaw<{id:string;xmin:string;body:string}[]>`SELECT t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT p.id::text,p.xmin::text,md5(to_jsonb(p)::text) FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY id`),moneyBefore=await money();
    await page.goto(`/${locale}/app/documents`);await selectProperty(page,fixture.property.name);
    await fillDefinition(page,{key,locale,title,heading:"Original heading {{property}}",text:body,reason:"Retain the original authored source text"});
    const admissionAck=acknowledgementBarrier();let admissions=0,completions=0;
    await page.route("**/api/documents/templates/admit",async route=>{admissions++;try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();admissionAck.resolve();}catch(error){admissionAck.reject(error);throw error;}});
    await page.getByTestId("template-save").click();await admissionAck.promise;await expect(page.getByTestId("document-recover")).toBeEnabled();expect(admissions).toBe(1);
    const originalAdmission=await withTenant(f.db,f.organizationId,tx=>tx.documentAdmission.findFirstOrThrow({where:{createdBy:fixture.actorId}}));expect(originalAdmission.payloadCipher).not.toBeNull();expect(Buffer.from(originalAdmission.payloadCipher!).includes(Buffer.from(marker))).toBe(false);expect(JSON.stringify(originalAdmission.input)).not.toContain(marker);
    expect(await withTenant(f.db,f.organizationId,tx=>tx.documentVersion.count({where:{documentId:originalAdmission.documentId}}))).toBe(0);
    const stored=await page.evaluate(()=>({session:{...sessionStorage},local:{...localStorage}}));expect(stored.session[storageKey]).toBe(originalAdmission.commandKey);expect(JSON.stringify(stored)).not.toContain(marker);expect(JSON.stringify(stored)).not.toContain("Retain the original authored source text");await page.unroute("**/api/documents/templates/admit");
    await page.reload();await expect(page.getByTestId("template-resume")).toBeEnabled();await expect(page.getByTestId("document-resume-file")).toHaveCount(0);
    const completionAck=acknowledgementBarrier();await page.route("**/api/documents/complete",async route=>{completions++;try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();completionAck.resolve();}catch(error){completionAck.reject(error);throw error;}});
    await page.getByTestId("template-resume").click();await completionAck.promise;await expect(page.getByTestId("document-recover")).toBeEnabled();expect(completions).toBe(1);expect(await withTenant(f.db,f.organizationId,tx=>tx.documentVersion.count({where:{documentId:originalAdmission.documentId}}))).toBe(1);
    await page.getByTestId("document-recover").click();await expect(page.getByTestId("document-version")).toHaveCount(1);await expect(page.getByTestId("document-recover")).toHaveCount(0);expect(completions).toBe(1);await page.unroute("**/api/documents/complete");expect(await page.evaluate(key=>sessionStorage.getItem(key),storageKey)).toBeNull();
    const originalVersion=await withTenant(f.db,f.organizationId,tx=>tx.documentVersion.findFirstOrThrow({where:{documentId:originalAdmission.documentId}})),originalRows=()=>withTenant(f.db,f.organizationId,tx=>tx.$queryRaw`SELECT v.id::text,v.xmin::text,md5(to_jsonb(v)::text) AS body FROM document_version v WHERE organization_id=${f.organizationId}::uuid AND id=${originalVersion.id}::uuid`),originalBefore=await originalRows();
    const pendingDownload=page.waitForEvent("download");await page.getByTestId("document-download").click();const downloaded=await pendingDownload,path=info.outputPath("authored-original.json");await downloaded.saveAs(path);const originalBytes=await readFile(path),decoded=decodeDocumentTemplate(originalBytes);expect(decoded).toMatchObject({templateKey:key,locale,blocks:[{kind:"PARAGRAPH",text:body}]});expect(createHash("sha256").update(originalBytes).digest("hex")).toBe(originalAdmission.sha256);
    await expect(page.getByTestId("document-amend")).toBeEnabled();await page.getByTestId("document-amend").click();await expect(page.getByTestId("template-section-text")).toHaveValue(body);await expect(page.getByTestId("template-code")).toBeDisabled();await expect(page.getByTestId("template-code")).toHaveValue(key);await expect(page.getByTestId("template-locale")).toBeDisabled();await expect(page.getByTestId("template-locale")).toHaveValue(locale);
    let invalidReviews=0;const countReviews=()=>{invalidReviews++;};page.on("request",request=>{if(new URL(request.url()).pathname==="/api/documents/templates/review")countReviews();});
    await page.getByTestId("template-section-text").fill(marker+" {{unavailable}}.");await page.getByTestId("template-reason").fill("Retain original while authoring an amendment");await page.getByTestId("template-save").click();await expect(page.getByTestId("document-template-editor").getByRole("alert")).toBeVisible();expect(invalidReviews).toBe(0);
    await page.getByTestId("template-section-text").fill(marker+" amendment {{property}}.");await saveDefinition(page);await expect(page.getByTestId("document-version")).toHaveCount(2);expect(await originalRows()).toEqual(originalBefore);expect(await money()).toEqual(moneyBefore);
    for(const language of ["en","fr"] as const){if(language===locale)continue;
      await expect(page.getByTestId("document-template-editor")).toBeVisible();await fillDefinition(page,{key,locale:language,title:"Authored "+language+" "+suffix,heading:(language==="fr"?"Convention":"Agreement")+" {{property}}",text:(language==="fr"?"Texte original français":"Original English text")+" {{property}}.",reason:"Explicitly authored language variant with the same variable contract"});await saveDefinition(page);
    }
    const variants=await withTenant(f.db,f.organizationId,tx=>tx.documentTemplate.findMany({where:{key},include:{document:{include:{versions:{orderBy:{number:"desc"},take:1}}}},orderBy:{locale:"asc"}}));expect(variants.map(variant=>variant.locale)).toEqual(locale==="ar"?["ar","en","fr"]:["en","fr"]);
    const definitions=[];for(const variant of variants){const response=await page.request.post("/api/documents/download",{headers,data:{versionId:variant.document.versions[0].id}});expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toBe("private, no-store");definitions.push(decodeDocumentTemplate(await response.body()));}expect(documentTemplateVariantsSchema.parse(definitions)).toHaveLength(variants.length);
    await page.getByTestId("document-item").filter({hasText:title}).click();await expect(page.getByTestId("document-version")).toHaveCount(2);await page.getByTestId("document-amend").click();await expect(page.getByTestId("template-section-text")).toHaveValue(marker+" amendment {{property}}.");
    expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(pageErrors).toEqual([]);await page.screenshot({path:info.outputPath("authored-template.png"),fullPage:true});
    await page.context().setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event("offline")));await expect(page.getByTestId("document-template-editor")).toHaveCount(0);await expect(page.getByTestId("document-version")).toHaveCount(0);expect(await page.locator("textarea").evaluateAll(elements=>elements.map(element=>element instanceof HTMLTextAreaElement?element.value:"").join("\n"))).not.toContain(marker);
    await page.context().setOffline(false);await page.evaluate(()=>window.dispatchEvent(new Event("online")));await page.goto(`/${locale}/app/documents`);await selectProperty(page,fixture.property.name);await page.getByTestId("document-item").filter({hasText:title}).click();await expect(page.getByTestId("document-version")).toHaveCount(2);await page.getByTestId("document-amend").click();await expect(page.getByTestId("template-section-text")).toHaveValue(marker+" amendment {{property}}.");await expect(page.getByTestId("template-section-text")).toBeEnabled();
    await withTenant(f.db,f.organizationId,tx=>tx.roleAssignment.updateMany({where:{userAccountId:fixture.actorId,archivedAt:null},data:{archivedAt:new Date()}}));await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect(page.getByTestId("document-private-unavailable")).toBeVisible();await expect(page.getByTestId("document-template-editor")).toHaveCount(0);await expect(page.getByTestId("document-version")).toHaveCount(0);
    expect((await page.request.post("/api/documents/download",{headers,data:{versionId:originalVersion.id}})).status()).toBe(403);expect(await originalRows()).toEqual(originalBefore);expect(await money()).toEqual(moneyBefore);
  }finally{await f.db.$disconnect();}
});
