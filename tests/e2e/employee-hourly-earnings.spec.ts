import { randomUUID } from "node:crypto";
import { expect,test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { assignTeamRole,saveTeamCompensation } from "@/modules/identity/application/team-service";
import { submitEmployeeWorkTime,decideEmployeeWorkTime } from "@/modules/finance/application/employee-work-time-service";
import { createEmployeeHourlyCompensationRun } from "@/modules/finance/application/employee-hourly-run-service";
import { employeeWorkTimeEvidenceSchema } from "@/modules/finance/domain/employee-work-time";
import { formatCurrencyAmount } from "@/i18n/format";
import { openFieldFixture } from "./support/field-fixture";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};
test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of ["en","fr","ar"] as const)test(`Native original hourly earning witnesses retain exact actual time and private history in ${locale}`,async({page,browser},info)=>{
 test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(180000);
 const f=await openFieldFixture(page,info,locale),messages={en,fr,ar}[locale].CompensationRuns,origin=new URL(page.url()).origin,anonymous=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]}});
 try{
  await page.getByTestId("field-checklist-item").check();await page.getByTestId("field-task-complete").click();
  await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{state:true}})).then(row=>row.state),{timeout:30000}).toBe("COMPLETED");
  const source=await withTenant(f.db,f.organizationId,async tx=>{const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),account=await tx.userAccount.findUniqueOrThrow({where:{id:task.assignedToUserAccountId!}}),role=task.requiredRoleKey?await tx.role.findUniqueOrThrow({where:{organizationId_key:{organizationId:f.organizationId,key:task.requiredRoleKey}}}):await tx.role.create({data:{organizationId:f.organizationId,key:"actual_hourly_"+randomUUID(),name:"Actual hourly work contract"}});return{task,account,role};});
  const actor={organizationId:f.organizationId,actorId:source.account.id,personId:source.account.personId,authContext:{...await authContextForAccount(f.organizationId,source.account.id,{db:f.db}),personId:source.account.personId}},assignment=await assignTeamRole(actor,{personId:source.account.personId,roleId:source.role.id,scopeType:"property",scopeId:source.task.propertyId,validFrom:"2020-01-01",validTo:null,assignedToMe:false,reason:"Actual original native hourly work contract"},{db:f.db});
  await saveTeamCompensation(actor,{assignmentId:assignment.id,expectedVersion:0,mode:"PER_HOUR",amount:"600.00",currency:"MAD",effectiveFrom:"2020-01-01",reason:"Actual original native hourly contractual rate"},{db:f.db});
  await withTenant(f.db,f.organizationId,async tx=>{const rules=new ConfigRuleRepository(tx,f.organizationId);for(const[key,value]of Object.entries({"staff.compensation_hourly_earnings":{evidence:"VALIDATED_COMPLETED_WORK_INTERVALS",rate_selection:"ACTUAL_EFFECTIVE_INSTANTS",rounding:"HALF_UP_AT_EARNING_TOTAL",max_interval_seconds:"7200",max_total_seconds:"14400",require_distinct_validator:false},"staff.compensation_hourly_runs":{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31,earning_unit:"VALIDATED_COMPLETED_WORK_SOURCE",rounding:"HALF_UP_AT_EARNING_TOTAL",overlap_between_sources:"REJECT_PER_PERSON"}})){await rules.lockVersion(key,"organization");if(!await rules.resolve({key,scopes:[{scopeType:"organization",scopeId:null}]}))await rules.createVersion({key,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value,reason:"Explicit native actual hourly earning and validation policy"});}});
  const end=Math.floor(source.task.completedAt!.getTime()/1000)*1000,intervals=Array.from({length:26},(_,index)=>({startsAt:new Date(end-(26-index)*3000).toISOString(),endsAt:new Date(end-(26-index)*3000+2000).toISOString(),note:null})),created=await submitEmployeeWorkTime(actor,{taskId:f.taskId,previousEvidenceId:null,kind:"ACTUAL_INTERVALS",intervals,reason:"Retain twenty-six actual original intervals for native financial evidence",idempotencyKey:randomUUID()},{db:f.db}),evidenceId=employeeWorkTimeEvidenceSchema.parse(created.evidence).id,decided=await decideEmployeeWorkTime(actor,{taskId:f.taskId,evidenceId,verdict:"APPROVED",reason:"Approve original actual native work intervals under explicit policy",idempotencyKey:randomUUID()},{db:f.db}),on=source.task.completedAt!.toISOString().slice(0,10),run=await createEmployeeHourlyCompensationRun(actor,{fromOn:on,toOn:on,currency:"MAD",jobs:[{taskId:f.taskId,assignmentId:assignment.id,evidenceId,decisionId:employeeWorkTimeEvidenceSchema.parse(decided.evidence).decision!.id,confirmedAssignment:true}],purpose:"Native actual validated hourly earnings",reason:"Retain actual original hourly earning witnesses and exact Money",idempotencyKey:randomUUID()},{db:f.db});
  expect(run.total).toEqual({amount:"8.67",currency:"MAD"});expect((await anonymous.request.get(`/api/finance/compensation/runs/${run.id}/detail`)).status()).toBe(401);
  await page.goto(`/${locale}/app/finance/compensation/${run.id}`);const panel=page.getByTestId("compensation-hourly-evidence");await expect(panel).toBeVisible();await expect(page.getByTestId("compensation-total")).toHaveText(formatCurrencyAmount(locale,"8.67","MAD"));await expect(panel.locator("ol > li")).toHaveCount(25);
  const next=panel.getByRole("button",{name:messages.hourlyNextRates,exact:true});await next.focus();await expect(next).toBeFocused();await next.press("Enter");await expect(panel.locator("ol > li")).toHaveCount(1);await panel.getByRole("button",{name:messages.hourlyPreviousRates,exact:true}).click();await expect(panel.locator("ol > li")).toHaveCount(25);
  expect((await new AxeBuilder({page}).include('[data-testid="compensation-hourly-evidence"]').analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.context().setOffline(true);await expect(page.getByTestId("compensation-error")).toContainText(messages.offline);await expect(panel).toHaveCount(0);await page.context().setOffline(false);await expect(panel).toBeVisible();
  expect(await withTenant(f.db,f.organizationId,tx=>tx.employeeCompensationHourlyWitness.count({where:{runLineId:run.lines[0].id}}))).toBe(26);
 }finally{await anonymous.close();await f.db.$disconnect();}
});
