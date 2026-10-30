import { randomUUID } from "node:crypto";
import { expect,test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { employeeCompensationRunViewSchema } from "@/modules/finance/domain/employee-compensation-run";
import { employeeCompensationSubmissionRequestViewSchema,employeeCompensationSubmissionViewSchema } from "@/modules/finance/domain/employee-compensation-claim";
import { employeeCompensationSubmissionRequested,executeEmployeeCompensationSubmissionReference } from "@/modules/finance/application/employee-compensation-submission-requests";
import { openCompensationApiFixture } from "./support/compensation-api";

test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of["en","fr","ar"] as const)test(`Native employee cost submission keeps real source, review and withdrawal after lost acknowledgements in ${locale}`,async({page,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(120000);
  const f=await openCompensationApiFixture(page,info,locale),origin=f.origin,base="/api/finance/compensation";
  const anonymous=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]}}),context=await browser.newContext({baseURL:origin,storageState:await page.context().storageState(),serviceWorkers:"block",userAgent:await page.evaluate(()=>navigator.userAgent),viewport:info.project.name==="field-mobile"?{width:360,height:800}:{width:1280,height:900}}),financialPage=await context.newPage();
  try{
    await withTenant(f.db,f.organizationId,async tx=>{
      const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),owner=await tx.owner.create({data:{organizationId:f.organizationId,displayName:"Actual native work cost owner"}});
      await tx.propertyOwner.create({data:{organizationId:f.organizationId,propertyId:task.propertyId,ownerId:owner.id}});const rules=new ConfigRuleRepository(tx,f.organizationId);
      await rules.createVersion({key:"staff.compensation_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31},reason:"Native completed-work cost proposal calendar"});
      await rules.createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:task.propertyId,effectiveFrom:new Date("2020-01-01"),value:{default_treatment:"ALVILLAS_PAID"},reason:"Actual configured native employer cost allocation"});
      await rules.createVersion({key:"finance.approval_thresholds",scopeType:"property",scopeId:task.propertyId,effectiveFrom:new Date("2020-01-01"),value:{thresholds:[{key:"native_employee_work_review",amount:"1.00",currency:"MAD",requires_approval_from:["finance"]}],routing:{finance:{people:[f.source.account.personId],roles:[],assigned:false,channels:["in_app"]}}},reason:"Explicit configured native employee work cost review"});
    });
    for(const check of await page.getByTestId("field-checklist-item").all())await check.check();await page.getByTestId("field-task-complete").click();
    await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{state:true}}).then(row=>row.state))).toBe("COMPLETED");
    const completed=await withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}})),on=completed.completedAt!.toISOString().slice(0,10);
    const runResponse=await page.request.post(base+"/runs",{headers:{origin},data:{fromOn:on,toOn:on,currency:"MAD",purpose:"Actual native earned-work cost proposal",reason:"Retain original native work and effective contract",idempotencyKey:randomUUID(),jobs:[{taskId:f.taskId,assignmentId:f.source.assignment.id,confirmedAssignment:true}]}});
    expect(runResponse.status()).toBe(200);const run=employeeCompensationRunViewSchema.passthrough().parse(await runResponse.json()),note="Review this actual original contracted work cost "+randomUUID(),input={runId:run.id,costOn:on,emergency:false,idempotencyKey:randomUUID(),reason:"Submit the actual original contracted work for review",costs:run.lines.map(line=>({runLineId:line.id,category:"staff",costCenter:null,note}))};
    expect((await anonymous.request.post(base+"/submissions",{headers:{origin},data:input})).status()).toBe(401);
    expect((await page.request.post(base+"/submissions",{headers:{origin:"https://foreign.example"},data:input})).status()).toBe(403);
    expect((await page.request.post(base+"/submissions",{headers:{origin},data:{...input,amount:"1.00"}})).status()).toBe(400);
    await financialPage.goto(`/${locale}/app/finance/compensation/${run.id}`);await expect(financialPage.getByTestId("compensation-purpose")).toBeVisible();
    let requestId:string|undefined;
    await financialPage.route(origin+base+"/submissions",async route=>{const response=await route.fetch();expect(response.status()).toBe(202);const queued=employeeCompensationSubmissionRequestViewSchema.parse(await response.json());requestId=queued.requestId;expect(queued.state).toBe("PENDING");await route.abort("failed");},{times:1});
    expect(await financialPage.evaluate(async({path,input})=>{try{await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});return false;}catch{return true;}},{path:base+"/submissions",input})).toBe(true);expect(requestId).toBeTruthy();
    const replayResponse=await financialPage.request.post(base+"/submissions",{headers:{origin},data:input});expect(replayResponse.status()).toBe(202);expect(replayResponse.headers()["cache-control"]).toBe("private, no-store");expect(employeeCompensationSubmissionRequestViewSchema.parse(await replayResponse.json())).toMatchObject({requestId,idempotent:true,state:"PENDING"});
    const event=await withTenant(f.db,f.organizationId,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:requestId!}}}));
    const finished=await executeEmployeeCompensationSubmissionReference({organizationId:f.organizationId,outboxEventId:event.id},{db:f.db});expect(finished.state).toBe("SUCCEEDED");expect(finished.submissionId).toBeTruthy();
    expect(await executeEmployeeCompensationSubmissionReference({organizationId:f.organizationId,outboxEventId:event.id},{db:f.db})).toMatchObject({state:"SUCCEEDED",submissionId:finished.submissionId,idempotent:true});
    const status=await financialPage.request.get(base+"/submission-requests/"+requestId);expect(status.status()).toBe(200);expect(employeeCompensationSubmissionRequestViewSchema.parse(await status.json())).toMatchObject({state:"SUCCEEDED",submissionId:finished.submissionId});
    const read=async()=>{const response=await financialPage.request.get(base+"/submissions/"+finished.submissionId);expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toBe("private, no-store");return employeeCompensationSubmissionViewSchema.parse(await response.json());};
    const proposed=await read();expect(proposed).toMatchObject({state:"PENDING_APPROVAL",total:{amount:"500.25",currency:"MAD"},costCount:1,claimCount:1});expect(proposed.approvalId).toBeTruthy();expect(proposed.costs[0]).toMatchObject({runLineId:run.lines[0].id,personId:f.source.account.personId,note});expect(JSON.stringify(proposed)).not.toMatch(/authorizationCap|policySnapshot|sourceSnapshot|requestFingerprint|idempotencyKey/u);
    await financialPage.goto(`/${locale}/app/approvals/${proposed.approvalId}`);await expect(financialPage.getByTestId("approval-financial-summary")).toBeVisible();await expect(financialPage.getByRole("heading",{name:note,exact:true})).toBeVisible();
    expect((await new AxeBuilder({page:financialPage}).include('[data-testid="approval-page"]').analyze()).violations).toEqual([]);expect(await financialPage.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await expect(financialPage.locator("html")).toHaveAttribute("dir",locale==="ar"?"rtl":"ltr");
    await financialPage.screenshot({path:info.outputPath("employee-work-cost-review.png"),fullPage:true});
    await financialPage.getByTestId("approval-reason").fill("Approve this actual original contracted work cost");
    await financialPage.route(origin+`/${locale}/app/approvals/${proposed.approvalId}`,async route=>{expect(route.request().headers()["next-action"]).toBeTruthy();const response=await route.fetch();expect(response.status()).toBe(200);await route.abort("failed");},{times:1});
    await financialPage.getByTestId("approval-approve").click();await expect(financialPage.getByRole("alert")).toBeVisible();
    await financialPage.getByTestId("approval-approve").click();await expect(financialPage.getByTestId("approval-approve")).toHaveCount(0);
    expect((await read()).state).toBe("APPROVED");
    const withdrawal={reason:"Withdraw this approved proposal before recognizing a claim"};const first=await financialPage.request.post(base+"/submissions/"+finished.submissionId+"/withdraw",{headers:{origin},data:withdrawal});expect(first.status()).toBe(200);const second=await financialPage.request.post(base+"/submissions/"+finished.submissionId+"/withdraw",{headers:{origin},data:withdrawal});expect(second.status()).toBe(200);expect(await second.json()).toMatchObject({id:finished.submissionId,idempotent:true});
    const history=await read();expect(history.state).toBe("WITHDRAWN");expect(history.history.map(event=>event.action)).toEqual(["SUBMITTED","APPROVED","WITHDRAWN"]);
    expect(await financialPage.evaluate(note=>{const stored=(store:Storage)=>Object.keys(store).map(key=>store.getItem(key)??"");return![...stored(localStorage),...stored(sessionStorage)].some(value=>value.includes(note)||value.includes("500.25"));},note)).toBe(true);
    const counts=await withTenant(f.db,f.organizationId,async tx=>({requests:await tx.employeeCompensationSubmissionRequest.count({where:{runId:run.id}}),submissions:await tx.employeeCompensationSubmission.count({where:{runId:run.id}}),decisions:await tx.auditLog.count({where:{action:"finance.employee_compensation.approval_stage_decided",resourceId:finished.submissionId!}})}));expect(counts).toEqual({requests:1,submissions:1,decisions:1});expect(await f.facts()).toBe(f.original);
    await withTenant(f.db,f.organizationId,async tx=>tx.roleAssignment.update({where:{id:f.source.assignment.id},data:{validTo:await new FinanceRepository(tx,f.organizationId).clock()}}));
    const denied=await financialPage.request.get(base+"/submissions/"+finished.submissionId);expect(denied.status()).toBe(403);expect(await denied.json()).toEqual({error:"forbidden"});expect(await f.facts()).toBe(f.original);
  }finally{await anonymous.close();await context.close();await f.db.$disconnect();}
});
