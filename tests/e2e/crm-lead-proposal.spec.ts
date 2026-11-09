import {nativeLeadDocumentBrowserFixture as fixture,nativeLeadDocumentBrowserTemplates as templates,selectNativeLeadDocumentBrowserTemplates as selectTemplates,privateNativeLeadBrowserStorage as privateStorage,nativeLeadBrowserFinancial as financial} from "./support/crm-document-fixtures";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {PrismaClient} from "@prisma/client";
import {getDocument} from "pdfjs-dist/legacy/build/pdf.mjs";
import AxeBuilder from "@axe-core/playwright";
import {test,expect} from "@playwright/test";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";





import {acknowledgementBarrier} from "./support/acknowledgement-barrier";
import {forwardBrowserPostOnce} from "./support/forward-browser-post";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};

const copy={en:en.LeadWorkspace,fr:fr.LeadWorkspace,ar:ar.LeadWorkspace};






for(const locale of["en","fr","ar"]as const){
 test(`Native lead proposal opens its private archive and recovers the original generated PDF in ${locale}`,async({page},info)=>{
  test.setTimeout(180000);const db=new PrismaClient(),errors:string[]=[];page.on("console",message=>{if(/MISSING_MESSAGE|INVALID_MESSAGE/u.test(message.text()))errors.push(message.text());});
  try{const f=await fixture(page,db,locale,info),before=await financial(db),variants=await templates(page,f);await page.getByRole("button",{name:copy[locale].proposalDocuments,exact:true}).click();await expect(page).toHaveURL(new RegExp("/"+locale+"/app/documents\\?lead="+f.lead.id));await expect(page.getByRole("heading",{name:f.owner,exact:true})).toBeVisible();await expect(page.getByTestId("document-source-kind")).toHaveValue("LEAD");
   await selectTemplates(page,f,variants);await page.getByTestId("generation-language").selectOption(locale==="en"?"en":"fr");await page.getByTestId("generation-title").fill("Native retained proposal "+f.marker);const reason="Actual private reviewed proposal "+randomUUID();await page.getByTestId("generation-reason").fill(reason);await page.getByTestId("generation-review").click();await expect(page.getByTestId("generation-reviewed")).toBeVisible();
   const admitted=acknowledgementBarrier();let admissions=0;await page.route("**/api/documents/generation/admit",async route=>{admissions++;try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();admitted.resolve();}catch(error){admitted.reject(error);throw error;}});await page.getByTestId("generation-generate").click();await admitted.promise;await expect(page.getByTestId("generation-recover")).toBeEnabled();expect(admissions).toBe(1);
   const instance=await withTenant(db,bootstrapOrganizationId,tx=>tx.documentInstance.findFirstOrThrow({where:{createdBy:f.account.id,document:{leadId:f.lead.id}}})),nonceKey="alvillas:document-generation:"+f.scope;expect(await page.evaluate(key=>sessionStorage.getItem(key),nonceKey)).toBe(instance.commandKey);for(const privateValue of[f.owner,reason])expect(await privateStorage(page)).not.toContain(privateValue);expect(JSON.stringify(instance.sourceSnapshot)).not.toContain(f.owner);
   await page.unroute("**/api/documents/generation/admit");await page.reload();await expect(page.getByRole("heading",{name:f.owner,exact:true})).toBeVisible();await page.getByTestId("generation-recover").click();await expect(page.getByTestId("generation-complete")).toBeEnabled();
   const completed=acknowledgementBarrier();let completions=0;await page.route("**/api/documents/generation/complete",async route=>{completions++;try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();completed.resolve();}catch(error){completed.reject(error);throw error;}});await page.getByTestId("generation-complete").click();await completed.promise;await expect(page.getByTestId("generation-recover")).toBeEnabled();await page.unroute("**/api/documents/generation/complete");await page.getByTestId("generation-recover").click();await expect(page.getByTestId("document-version")).toHaveCount(1);expect(completions).toBe(1);expect(await page.evaluate(key=>sessionStorage.getItem(key),nonceKey)).toBeNull();
   const downloaded=page.waitForEvent("download");await page.getByTestId("document-download").click();const file=await downloaded,path=info.outputPath("actual-native-lead-proposal.pdf");await file.saveAs(path);const bytes=await readFile(path),task=getDocument({data:new Uint8Array(bytes),useSystemFonts:false,useWorkerFetch:false,useWasm:false,disableFontFace:true}),pdf=await task.promise;try{const first=await pdf.getPage(1),content=await first.getTextContent();expect(content.items.map(item=>"str"in item?item.str:"").join(" ")).toContain(f.owner);}finally{await task.destroy();}
   expect(await withTenant(db,bootstrapOrganizationId,tx=>tx.documentVersion.count({where:{documentId:instance.documentId}}))).toBe(1);expect(await financial(db)).toEqual(before);await page.setViewportSize({width:360,height:800});await expect.poll(()=>page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))).toEqual({width:360,scroll:360});expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);expect(errors).toEqual([]);await page.screenshot({path:info.outputPath("native-proposal-"+locale+"-360.png"),fullPage:true});
  }finally{await db.$disconnect();}
 });
 test(`Bookmarked native lead archive restores after offline wiping and denies withdrawn access in ${locale}`,async({page,context},info)=>{
  test.setTimeout(180000);const db=new PrismaClient();try{const f=await fixture(page,db,locale,info),before=await financial(db);await page.getByRole("button",{name:copy[locale].proposalDocuments,exact:true}).click();await expect(page).toHaveURL(new RegExp("/"+locale+"/app/documents\\?lead="+f.lead.id));await expect(page.getByTestId("document-archive-workspace")).toBeVisible();await expect(page.getByTestId("document-source-kind")).toHaveValue("LEAD");await expect(page.getByRole("heading",{name:f.owner,exact:true})).toBeVisible();
   await context.setOffline(true);await expect(page.getByTestId("document-private-unavailable")).toBeVisible();await expect(page.locator("body")).not.toContainText(f.owner);await context.setOffline(false);await expect(page.getByRole("heading",{name:f.owner,exact:true})).toBeVisible();
   await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["lead:view"]},data:{validTo:new Date("2020-01-02")}}));await page.reload();await expect(page.getByTestId("document-private-unavailable")).toBeVisible();await expect(page.locator("body")).not.toContainText(f.owner);expect(await privateStorage(page)).not.toContain(f.owner);expect(await financial(db)).toEqual(before);await page.screenshot({path:info.outputPath("native-proposal-denied-"+locale+".png"),fullPage:true});
  }finally{await context.setOffline(false);await db.$disconnect();}
 });
}
