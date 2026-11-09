import {randomUUID} from "node:crypto";
import {test,expect} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {captureLead} from "@/modules/crm/application/lead-capture-service";
import {leadCapturePolicySchema} from "@/modules/crm/domain/lead-capture";
import {leadAnalyticsResultSchema,leadAnalyticsPolicyKey} from "@/modules/crm/domain/lead-analytics";
import {nativeLeadConversionBrowserFlow} from "./support/crm-conversion-browser-flow";
import {privateNativeLeadBrowserStorage,nativeLeadBrowserFinancial} from "./support/crm-document-fixtures";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};

const messages={en,fr,ar};
for(const locale of["en","fr","ar"]as const)test("Actual original acquisition analytics preserves conversion, paging and private authority in "+locale,async({page,context},info)=>{
 await nativeLeadConversionBrowserFlow(page,context,locale,info,"CREATE",{afterConversion:async({f,db,actor,conversion})=>{
  const financial=await nativeLeadBrowserFinancial(db),sourcePrefix="analytics_"+randomUUID().replaceAll("-","").slice(0,12),sources=Array.from({length:25},(_,index)=>({key:sourcePrefix+"_"+index,label:{en:"Retained acquisition "+index,fr:"Acquisition conservée "+index,ar:"مصدر استحواذ محفوظ "+index},channels:["MANUAL"as const]}));
  const original=await withTenant(db,bootstrapOrganizationId,async tx=>{
   const lead=await tx.lead.findUniqueOrThrow({where:{id:f.lead.id}}),config=new ConfigRuleRepository(tx,bootstrapOrganizationId),rule=await config.resolve({key:"crm.lead_capture",scopes:[{scopeType:"organization",scopeId:null}],asOf:new Date()});
   const policy=leadCapturePolicySchema.parse(rule?.parsedValue);
   await config.createVersion({key:"crm.lead_capture",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...policy,sources:[...policy.sources,...sources]},reason:"Actual owned source paging fixture; retained original acquisition attribution"});
   await config.createVersion({key:leadAnalyticsPolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{source:"NATIVE_LEAD_CAPTURE_AND_OWNER_CONVERSION",attribution:"ORIGINAL_CAPTURE",conversion:"NATIVE_OWNER_CONVERSION",labels:"RETAIN_CAPTURED_SOURCE_LABELS",max_range_seconds:31536000,max_source_groups:1000,read_admission:{requests:1000,window_seconds:3600}},reason:"Explicit owned acquisition analytics rule; no hosted acceptance claim"});
   return lead;
  });
  for(const source of sources)await captureLead(actor,{...f.input,idempotencyKey:randomUUID(),channel:"MANUAL",sourceKey:source.key},{db});
  await page.getByRole("link",{name:messages[locale].LeadAnalytics.title,exact:true}).click();await expect(page.getByTestId("lead-analytics-form")).toBeVisible();
  const from=original.createdAt.toISOString(),number=new Intl.NumberFormat(locale),copy=messages[locale].LeadAnalytics;
  await page.getByTestId("lead-analytics-from").fill(from.replace(/Z$/u,""));
  const response=page.waitForResponse(value=>value.url().endsWith("/api/crm/leads/analytics/read")&&value.request().method()==="POST");await page.getByTestId("lead-analytics-run").click();
  const read=await response;expect(read.status()).toBe(200);const report=leadAnalyticsResultSchema.parse(await read.json());
  expect(report.totals).toMatchObject({captured:"26",converted:"1"});expect(report.sources).toHaveLength(26);expect(report.totals.stages.find(stage=>stage.stage==="SIGNED")?.count).toBe("1");
  expect(report.sources.find(source=>source.sourceKey===f.input.sourceKey)).toMatchObject({captured:"1",converted:"1"});
  const total=(captured:string,converted:string)=>copy.conversionFraction.replace("{converted}",number.format(BigInt(converted))).replace("{captured}",number.format(BigInt(captured)));
  await expect(page.getByTestId("lead-analytics-totals")).toHaveText(total("26","1"));await expect(page.getByTestId("lead-analytics-source-row")).toHaveCount(20);
  await page.getByRole("button",{name:copy.next,exact:true}).click();await expect(page.getByTestId("lead-analytics-source-row")).toHaveCount(6);
  await page.getByRole("button",{name:copy.previous,exact:true}).click();await page.getByTestId("lead-analytics-source-row").first().getByRole("button").click();await expect(page.getByTestId("lead-analytics-all-sources")).toBeVisible();await expect(page.getByTestId("lead-analytics-source-row")).toHaveCount(1);
  await page.getByTestId("lead-analytics-all-sources").click();await expect(page.getByTestId("lead-analytics-totals")).toHaveText(total("26","1"));
  const serialized=JSON.stringify(report);for(const privateValue of[f.owner,f.input.fields.email!,conversion.ownerId,f.account.id])expect(serialized).not.toContain(privateValue);
  for(const label of sources.map(source=>source.label[locale]))expect(await privateNativeLeadBrowserStorage(page)).not.toContain(label);
  await page.setViewportSize({width:360,height:800});await expect.poll(()=>page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}))).toEqual({width:360,scroll:360});
  expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);await page.screenshot({path:info.outputPath("actual-original-acquisition-analytics-"+locale+"-360.png"),fullPage:true});
  await context.setOffline(true);await expect(page.getByTestId("lead-analytics-private-unavailable")).toBeVisible();await expect(page.getByTestId("lead-analytics-report")).toHaveCount(0);await expect(page.getByTestId("lead-analytics-from")).toHaveCount(0);
  await context.setOffline(false);await expect(page.getByTestId("lead-analytics-form")).toBeVisible();await expect(page.getByTestId("lead-analytics-from")).toHaveValue("");await expect(page.getByTestId("lead-analytics-report")).toHaveCount(0);
  await page.getByTestId("lead-analytics-from").fill(from.replace(/Z$/u,""));
  const withdrawn=await withTenant(db,bootstrapOrganizationId,async tx=>{const row=await tx.roleAssignment.findUniqueOrThrow({where:{id:f.grants["lead:export"]}});await tx.roleAssignment.update({where:{id:row.id},data:{validTo:new Date("2020-01-02")}});return row;});
  const denied=page.waitForResponse(value=>value.url().endsWith("/api/crm/leads/analytics/read")&&value.request().method()==="POST");await page.getByTestId("lead-analytics-run").click();const rejected=await denied;expect(rejected.status()).toBe(403);expect(await rejected.text()).not.toContain(f.owner);await expect(page.getByTestId("lead-analytics-private-unavailable")).toBeVisible();await expect(page.getByTestId("lead-analytics-report")).toHaveCount(0);
  // Restore by a new assignment; preserve the withdrawn grant and its history.
  await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.create({data:{organizationId:bootstrapOrganizationId,userAccountId:f.account.id,personId:f.account.personId,roleId:withdrawn.roleId,scopeType:"organization",validFrom:new Date()}}));
  expect(await nativeLeadBrowserFinancial(db)).toEqual(financial);await page.goto(`/${locale}/app/crm?lead=${f.lead.id}`);await expect(page.getByTestId("lead-current-details")).toBeVisible();
 }});
});
