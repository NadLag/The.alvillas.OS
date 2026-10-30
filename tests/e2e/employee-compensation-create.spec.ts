import { randomUUID } from "node:crypto";
import { expect,test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { assignTeamRole,saveTeamCompensation } from "@/modules/identity/application/team-service";
import { employeeCompensationRunViewSchema } from "@/modules/finance/domain/employee-compensation-run";
import { openCompensationApiFixture } from "./support/compensation-api";
test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of["en","fr","ar"] as const)test(`Native compensation creation explicitly selects an overlapping contract and recovers a lost save in ${locale}`,async({page,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(120000);
  const f=await openCompensationApiFixture(page,info,locale),origin=f.origin;
  const financialContext=await browser.newContext({baseURL:origin,storageState:await page.context().storageState(),serviceWorkers:"block",userAgent:await page.evaluate(()=>navigator.userAgent),viewport:info.project.name==="field-mobile"?{width:360,height:800}:{width:1280,height:900}}),financialPage=await financialContext.newPage();
  try{
    await withTenant(f.db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"staff.compensation_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31},reason:"Native real work selection calendar"}));
    const property=await withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{propertyId:true}}));
    const alternate=await assignTeamRole(f.actor,{personId:f.source.account.personId,userAccountId:f.source.account.id,roleId:f.source.assignment.roleId,scopeType:"property",scopeId:property.propertyId,
      validFrom:"2020-01-01",validTo:null,assignedToMe:false,reason:"Explicit property contract beside the organization contract"},{db:f.db});
    await saveTeamCompensation(f.actor,{assignmentId:alternate.id,expectedVersion:0,mode:"PER_JOB",amount:"750.00",currency:"MAD",effectiveFrom:new Date().toISOString(),reason:"Actual native alternative property compensation rate"},{db:f.db});
    for(const check of await page.getByTestId("field-checklist-item").all())await check.check();await page.getByTestId("field-task-complete").click();
    await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{state:true}}).then(row=>row.state))).toBe("COMPLETED");
    await financialPage.goto(`/${locale}/app/finance/compensation`);await financialPage.getByTestId("compensation-new").click();await expect(financialPage.getByTestId("compensation-create-form")).toBeVisible();
    await expect(financialPage.getByTestId(`compensation-choice-${f.source.assignment.id}`)).not.toBeChecked();await expect(financialPage.getByTestId(`compensation-choice-${alternate.id}`)).not.toBeChecked();
    await financialPage.getByTestId(`compensation-choice-${alternate.id}`).check();
    const purpose="Actual native explicit contract selection "+randomUUID(),reason="Retain this selected completed work and original contract";
    await financialPage.getByTestId("compensation-create-purpose").fill(purpose);await financialPage.getByTestId("compensation-create-reason").fill(reason);
    expect((await new AxeBuilder({page:financialPage}).include('[data-testid="compensation-new-page"]').analyze()).violations).toEqual([]);
    expect(await financialPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    await financialPage.screenshot({path:info.outputPath("compensation-create.png"),fullPage:true});
    let committedId:string|undefined;
    await financialPage.route(origin+"/api/finance/compensation/runs",async route=>{
      const response=await route.fetch();expect(response.status()).toBe(200);const parsed=employeeCompensationRunViewSchema.passthrough().parse(await response.json());committedId=parsed.id;expect(parsed.total).toEqual({amount:"750.00",currency:"MAD"});expect(parsed.lines[0].assignmentId).toBe(alternate.id);await route.abort("failed");
    },{times:1});
    await financialPage.getByTestId("compensation-create").click();await expect(financialPage.getByTestId("compensation-command-error")).toBeVisible();expect(committedId).toBeTruthy();
    const savedKeys=await financialPage.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith("alvillas.compensation.pending.v1.")).map(key=>({key,value:sessionStorage.getItem(key)})));
    expect(savedKeys).toHaveLength(1);expect(savedKeys[0].value).toMatch(/^[a-f0-9-]{36}$/u);expect(JSON.stringify(savedKeys)).not.toContain(purpose);expect(JSON.stringify(savedKeys)).not.toContain("750.00");
    if(locale==="fr")await financialPage.getByTestId("compensation-create").click();else await financialPage.reload();
    await expect(financialPage).toHaveURL(new RegExp(`/${locale}/app/finance/compensation/${committedId}$`,"u"));await expect(financialPage.getByTestId("compensation-purpose")).toHaveText(purpose);await expect(financialPage.getByTestId("compensation-source")).toHaveCount(1);
    expect(await financialPage.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith("alvillas.compensation.pending.v1.")).length)).toBe(0);
    const rows=await withTenant(f.db,f.organizationId,async tx=>({runs:await tx.employeeCompensationRun.count({where:{purpose}}),lines:await tx.employeeCompensationRunLine.findMany({where:{runId:committedId!},select:{assignmentId:true,amount:true}}),audits:await tx.auditLog.count({where:{action:"finance.employee_compensation_run.created",resourceId:committedId!}})}));
    expect(rows.runs).toBe(1);expect(rows.audits).toBe(1);expect(rows.lines).toHaveLength(1);expect(rows.lines[0].assignmentId).toBe(alternate.id);expect(rows.lines[0].amount.toFixed(2)).toBe("750.00");expect(await f.facts()).toBe(f.original);
  }finally{await financialContext.close();await f.db.$disconnect();}
});
