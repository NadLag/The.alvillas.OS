import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {PrismaClient} from "@prisma/client";
import {test,expect} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {withTenant} from "@/platform/db/tenant";
import {prepareOwnerPackageBrowserFixture} from "./support/onboarding-owner-package-fixture";
import {nativeLeadBrowserFinancial} from "./support/crm-document-fixtures";
import {e2eEmail,ensureE2EAccount,waitForE2EAdminLoginWindow,completeE2EAdminMfa} from "./support/auth";
import {acknowledgementBarrier} from "./support/acknowledgement-barrier";
import {forwardBrowserPostOnce} from "./support/forward-browser-post";

for(const locale of["en","fr","ar"]as const)test("Native owner report retains bilingual originals and private recovery in "+locale,async({page},info)=>{
 test.setTimeout(240000);const url=process.env.DATABASE_URL?new URL(process.env.DATABASE_URL):null;if(!url||!["127.0.0.1","localhost"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned migrated237 browser database required");
 const db=new PrismaClient(),email=e2eEmail("owner-report-"+locale+"-"+randomUUID(),info.project.name),password=process.env.ADMIN_PASSWORD??"correct horse battery staple",errors:string[]=[];page.on("pageerror",error=>errors.push(error.name));
 try{
  await ensureE2EAccount(email,password,{permissionKeys:["document:view"],page});const account=await withTenant(db,bootstrapOrganizationId,tx=>tx.userAccount.findUniqueOrThrow({where:{organizationId_email:{organizationId:bootstrapOrganizationId,email}}}));
  await page.goto("/en/login");await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);await page.getByTestId("login-submit").click();await completeE2EAdminMfa(page,email);await expect(page).toHaveURL(/\/en\/app/u);
  const f=await prepareOwnerPackageBrowserFixture({organizationId:bootstrapOrganizationId,accountId:account.id,origin:new URL(page.url()).origin,output:info.outputPath("native-owner-report-fixture.private.json")}),financial=await nativeLeadBrowserFinancial(db);
  if(info.project.name==="field-mobile")await page.setViewportSize({width:360,height:800});
  for(const language of["en","fr"]as const){
   await page.goto(`/${locale}/app/documents`);await page.getByTestId("document-source-kind").selectOption("ONBOARDING");await page.getByTestId("document-source-query").fill(f.review.id);await expect(page.getByTestId("document-source")).toHaveCount(1);await page.getByTestId("document-source").click();
   const panel=page.getByTestId("document-generation");await panel.getByRole("combobox").first().selectOption("ONBOARDING");await page.getByTestId("generation-library-query").fill(f.review.id);await page.getByTestId("generation-find-sources").click();await expect(page.getByTestId("generation-library-source")).toHaveCount(1);await page.getByTestId("generation-library-source").click();
   for(const definition of f.definitions){await page.getByTestId(`generation-${definition.locale}-template`).selectOption(definition.documentId);await page.getByTestId(`generation-${definition.locale}-version`).selectOption(definition.versionId);}
   await page.getByTestId("generation-language").selectOption(language);await page.getByTestId("generation-title").fill(language==="en"?"Actual original owner onboarding report":"Dossier original réel du propriétaire");await page.getByTestId("generation-reason").fill("Actual approved complete native owner report "+language);await page.getByTestId("generation-review").click();await expect(page.getByTestId("generation-reviewed")).toBeVisible();
   if(language==="en"){const accepted=acknowledgementBarrier();await page.route("**/api/documents/generation/admit",async route=>{try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();accepted.resolve();}catch(error){accepted.reject(error);throw error;}});await page.getByTestId("generation-generate").click();await accepted.promise;await page.unroute("**/api/documents/generation/admit");await page.reload();await page.getByTestId("generation-recover").click();}else await page.getByTestId("generation-generate").click();
   await expect(page.getByTestId("generation-complete")).toBeEnabled();await page.getByTestId("generation-complete").click();await expect(page.getByTestId("document-version")).toHaveCount(1);await expect(page.getByTestId("generation-recover")).toHaveCount(0);
   const downloading=page.waitForEvent("download");await page.getByTestId("document-download").click();const file=await downloading,path=info.outputPath("original-owner-package-"+language+".pdf");await file.saveAs(path);const bytes=await readFile(path),task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,useWorkerFetch:false,useWasm:false,disableFontFace:true,verbosity:0});try{const pdf=await task.promise,text=[];for(let index=1;index<=pdf.numPages;index++)text.push((await(await pdf.getPage(index)).getTextContent()).items.map(item=>"str"in item?item.str:"").join(" "));expect(text.join(" ")).toContain(f.propertyName);expect(text.join(" ")).toContain(f.agreementReference);expect(pdf.numPages).toBeGreaterThanOrEqual(2);}finally{await task.destroy();}
  }
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(JSON.stringify(await page.evaluate(()=>({session:{...sessionStorage},local:{...localStorage}})))).not.toContain(f.agreementId);expect(errors).toEqual([]);
  const retained=await withTenant(db,f.organizationId,async tx=>({instances:await tx.documentInstance.findMany({where:{document:{sourceKind:"ONBOARDING",sourceId:f.review.id}}}),versions:await tx.documentVersion.count({where:{document:{sourceKind:"ONBOARDING",sourceId:f.review.id,kind:"INSTANCE"}}}),tasks:await tx.operationTask.count({where:{propertyId:f.review.propertyId}}),property:await tx.property.findUniqueOrThrow({where:{id:f.review.propertyId}})}));expect(retained.instances).toHaveLength(2);expect(retained.versions).toBe(2);expect(retained.tasks).toBe(0);expect(retained.property.status).toBe("DRAFT");expect(await nativeLeadBrowserFinancial(db)).toEqual(financial);
 }finally{await db.$disconnect();}
});
