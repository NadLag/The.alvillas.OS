import { expect,test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { openFieldFixture } from "./support/field-fixture";
import {utcDateTimeLocalValue} from "./support/date-time-local";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};

test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of ["en","fr","ar"] as const)test(`Native actual work-time evidence, recovery, validation and linked history in ${locale}`,async({page,browser},info)=>{
 test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(180000);
 const f=await openFieldFixture(page,info,locale),messages={en,fr,ar}[locale].WorkTime;
 const origin=new URL(page.url()).origin,anonymous=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]}});
 try{
  await page.getByTestId("field-checklist-item").check();await page.getByTestId("field-task-complete").click();
  await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{state:true}})).then(row=>row.state),{timeout:30000}).toBe("COMPLETED");
  const source=await withTenant(f.db,f.organizationId,async tx=>{const rules=new ConfigRuleRepository(tx,f.organizationId),key="staff.compensation_hourly_earnings";await rules.lockVersion(key,"organization");const current=await rules.resolve({key,scopes:[{scopeType:"organization",scopeId:null}]});if(!current)await rules.createVersion({key,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{evidence:"VALIDATED_COMPLETED_WORK_INTERVALS",rate_selection:"ACTUAL_EFFECTIVE_INSTANTS",rounding:"HALF_UP_AT_EARNING_TOTAL",max_interval_seconds:"7200",max_total_seconds:"14400",require_distinct_validator:false},reason:"Explicit native actual time evidence policy with self-validation permitted"});return tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{completedAt:true}});});
  const end=new Date(Math.floor(source.completedAt!.getTime()/1000)*1000),start=new Date(end.getTime()-3600000),base="/api/operations/work-time";
  expect((await anonymous.request.post(base+"/read",{headers:{Origin:origin},data:{taskId:f.taskId}})).status()).toBe(401);
  await page.goto(`/${locale}/app/operations/${f.taskId}`);const panel=page.getByTestId("work-time-panel");await expect(panel).toBeVisible();
  const begin=panel.getByTestId("work-time-start-0"),finish=panel.getByTestId("work-time-end-0");
  await begin.fill(utcDateTimeLocalValue(start));await finish.fill(utcDateTimeLocalValue(end));await begin.focus();await expect(begin).toBeFocused();
  await panel.getByTestId("work-time-reason").fill("Record actual native work interval with original completion");
  let dropped=false;await page.route("**/api/operations/work-time/submit",async route=>{if(dropped){await route.continue();return;}dropped=true;const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort("failed");});
  await panel.getByTestId("work-time-submit").click();await expect(panel.getByRole("alert")).toHaveText(messages.uncertain);
  await page.unroute("**/api/operations/work-time/submit");await page.reload();await expect(panel.getByText(messages.saved,{exact:true})).toBeVisible();await expect(panel.getByTestId("work-time-history")).toHaveCount(1);
  await panel.getByRole("button",{name:messages.newVersion,exact:true}).click();
  await begin.fill(utcDateTimeLocalValue(new Date(end.getTime()-1800000)));await finish.fill(utcDateTimeLocalValue(end));await panel.getByTestId("work-time-reason").fill("Correct actual work interval through a linked native version");
  dropped=false;await page.route("**/api/operations/work-time/submit",async route=>{if(dropped){await route.continue();return;}dropped=true;const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort("failed");});
  await panel.getByTestId("work-time-submit").click();await expect(panel.getByRole("alert")).toHaveText(messages.uncertain);await page.unroute("**/api/operations/work-time/submit");await panel.getByRole("button",{name:messages.retryExact,exact:true}).click();
  await expect(panel.getByTestId("work-time-history")).toHaveCount(2);
  await panel.getByTestId("work-time-decision-reason").fill("Validate actual original interval evidence under explicit policy");await panel.getByTestId("work-time-decide").click();await expect(panel.getByTestId("work-time-history").first()).toContainText(messages.APPROVED);
  expect((await new AxeBuilder({page}).include('[data-testid="work-time-panel"]').analyze()).violations).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.context().setOffline(true);await expect(panel.getByRole("alert")).toContainText(messages.offline);await expect(panel.getByTestId("work-time-history")).toHaveCount(0);await page.context().setOffline(false);await expect(panel.getByTestId("work-time-history")).toHaveCount(2);
  const result=await withTenant(f.db,f.organizationId,async tx=>({evidence:await tx.employeeWorkTimeEvidence.findMany({where:{taskId:f.taskId},orderBy:{version:"asc"},include:{intervals:true,decision:true}}),audits:await tx.auditLog.count({where:{resourceId:f.taskId,action:{in:["operations.work_time.submitted","operations.work_time.decided"]}}}),events:await tx.outboxEvent.count({where:{type:{in:["EmployeeWorkTimeSubmitted","EmployeeWorkTimeDecided"]},payload:{path:["taskId"],equals:f.taskId}}})}));
  expect(result.evidence).toHaveLength(2);expect(result.evidence[1].previousEvidenceId).toBe(result.evidence[0].id);expect(result.evidence[1].decision?.verdict).toBe("APPROVED");expect(result.evidence[0].intervals[0].startsAt.toISOString()).toBe(start.toISOString());expect(result.audits).toBe(3);expect(result.events).toBe(3);
 }finally{await f.db.$disconnect();await anonymous.close();}
});
