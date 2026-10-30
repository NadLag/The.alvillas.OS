import { randomUUID } from "node:crypto";
import { expect,test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { employeeCompensationRunViewSchema } from "@/modules/finance/domain/employee-compensation-run";
import { employeeCompensationRunDetailSchema } from "@/modules/finance/domain/employee-compensation-workspace";
import { openCompensationApiFixture } from "./support/compensation-api";

test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of["en","fr","ar"] as const)test(`Native compensation workspace reviews actual sources, recovers cancellation acknowledgement and clears expired authority in ${locale}`,async({page,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(120000);
  const f=await openCompensationApiFixture(page,info,locale),origin=f.origin;
  const financialContext=await browser.newContext({baseURL:origin,storageState:await page.context().storageState(),serviceWorkers:"block",userAgent:await page.evaluate(()=>navigator.userAgent),viewport:info.project.name==="field-mobile"?{width:360,height:800}:{width:1280,height:900}});
  const financialPage=await financialContext.newPage();
  try{
    await withTenant(f.db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"staff.compensation_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),
      value:{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31},reason:"Actual native workspace earning calendar"}));
    for(const check of await page.getByTestId("field-checklist-item").all())await check.check();await page.getByTestId("field-task-complete").click();
    await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{state:true}}).then(row=>row.state))).toBe("COMPLETED");
    const completed=await withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}})),on=completed.completedAt!.toISOString().slice(0,10),purpose="Native compensation workspace "+randomUUID();
    const response=await financialPage.request.post("/api/finance/compensation/runs",{headers:{origin},data:{fromOn:on,toOn:on,currency:"MAD",purpose,reason:"Retain the actual native completed-work evidence",idempotencyKey:randomUUID(),jobs:[{taskId:f.taskId,assignmentId:f.source.assignment.id,confirmedAssignment:true}]}});
    expect(response.status()).toBe(200);const run=employeeCompensationRunViewSchema.extend({idempotent:z.boolean()}).parse(await response.json());
    await financialPage.goto(`/${locale}/app`);await financialPage.getByTestId("compensation-link").click();await expect(financialPage.getByTestId("compensation-page")).toBeVisible();
    await financialPage.getByTestId("compensation-search").fill(purpose);await financialPage.locator('.compensation-filters button[type="submit"]').click();
    await expect(financialPage.getByTestId("compensation-run-row")).toHaveCount(1);
    expect(await financialPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await financialPage.getByTestId("compensation-open").click();
    await expect(financialPage.getByTestId("compensation-purpose")).toHaveText(purpose);await expect(financialPage.getByTestId("compensation-source")).toHaveCount(1);
    const detailResponse=await financialPage.request.get(`/api/finance/compensation/runs/${run.id}/detail`);expect(detailResponse.status()).toBe(200);expect(detailResponse.headers()["cache-control"]).toBe("private, no-store");
    const model=employeeCompensationRunDetailSchema.parse(await detailResponse.json());expect(model.total).toEqual({amount:"500.25",currency:"MAD"});
    await expect(financialPage.getByTestId("compensation-performer")).toHaveText(model.labels[0].personName!);await expect(financialPage.getByTestId("compensation-property")).toHaveText(model.labels[0].propertyName!);
    expect((await new AxeBuilder({page:financialPage}).include('[data-testid="compensation-detail-page"]').analyze()).violations).toEqual([]);
    expect(await financialPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const before=await withTenant(f.db,f.organizationId,async tx=>({root:await tx.employeeCompensationRun.findUniqueOrThrow({where:{id:run.id}}),lines:await tx.employeeCompensationRunLine.findMany({where:{runId:run.id},orderBy:{id:"asc"}})}));
    const reason="Cancel from the real workspace without losing original evidence";await financialPage.getByTestId("compensation-cancel-reason").fill(reason);
    await financialPage.route(origin+`/api/finance/compensation/runs/${run.id}/cancel`,async route=>{const committed=await route.fetch();expect(committed.status()).toBe(200);await route.abort("failed");},{times:1});
    await financialPage.getByTestId("compensation-cancel").click();await expect(financialPage.getByTestId("compensation-command-error")).toBeVisible();await expect(financialPage.getByTestId("compensation-cancel-reason")).toHaveAttribute("readonly","");
    await financialPage.getByTestId("compensation-cancel").click();await expect(financialPage.getByTestId("compensation-cancel-form")).toHaveCount(0);await expect(financialPage.getByTestId("compensation-purpose")).toHaveText(purpose);
    expect(await withTenant(f.db,f.organizationId,async tx=>({root:await tx.employeeCompensationRun.findUniqueOrThrow({where:{id:run.id}}),lines:await tx.employeeCompensationRunLine.findMany({where:{runId:run.id},orderBy:{id:"asc"}})}))).toEqual(before);
    expect(await withTenant(f.db,f.organizationId,tx=>tx.auditLog.count({where:{resourceId:run.id,action:"finance.employee_compensation_run.cancelled"}}))).toBe(1);
    await financialContext.setOffline(true);await expect(financialPage.getByTestId("compensation-error")).toBeVisible();await expect(financialPage.getByTestId("compensation-purpose")).toHaveCount(0);
    await financialContext.setOffline(false);await expect(financialPage.getByTestId("compensation-purpose")).toHaveText(purpose);
    await withTenant(f.db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.source.assignment.id},data:{validTo:new Date()}}));
    await financialPage.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect(financialPage.getByTestId("compensation-error")).toBeVisible();await expect(financialPage.getByTestId("compensation-purpose")).toHaveCount(0);await expect(financialPage.getByTestId("compensation-source")).toHaveCount(0);
    expect(await f.facts()).toBe(f.original);
  }finally{await financialContext.close();await f.db.$disconnect();}
});
