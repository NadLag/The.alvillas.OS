import { randomUUID } from "node:crypto";
import { expect,test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { employeeCompensationRunViewSchema } from "@/modules/finance/domain/employee-compensation-run";
import { openCompensationApiFixture } from "./support/compensation-api";

const createdSchema=employeeCompensationRunViewSchema.extend({idempotent:z.boolean()}),failure=z.object({error:z.string()}).strict(),path="/api/finance/compensation/runs";
test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of["en","fr","ar"] as const)test(`Native compensation run retains actual work through lost acknowledgement, read, cancellation and expired authority in ${locale}`,async({page,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(120000);
  const f=await openCompensationApiFixture(page,info,locale),origin=f.origin;
  const anonymous=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]}});
  const accountContext=await browser.newContext({baseURL:origin,storageState:await page.context().storageState(),serviceWorkers:"block",userAgent:await page.evaluate(()=>navigator.userAgent)});
  const financialPage=await accountContext.newPage();
  try{
    await withTenant(f.db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"staff.compensation_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),
      value:{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31},reason:"Actual native compensation run earning calendar"}));
    for(const check of await page.getByTestId("field-checklist-item").all())await check.check();await page.getByTestId("field-task-complete").click();
    await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId},select:{state:true}}).then(row=>row.state))).toBe("COMPLETED");
    const completed=await withTenant(f.db,f.organizationId,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}})),on=completed.completedAt!.toISOString().slice(0,10);
    const input={fromOn:on,toOn:on,currency:"MAD",purpose:"Actual completed work contractual run",reason:"Review actual immutable source and compensation",idempotencyKey:randomUUID(),
      jobs:[{taskId:f.taskId,assignmentId:f.source.assignment.id,confirmedAssignment:true}]};
    const unauthorized=await anonymous.request.post(path,{headers:{origin},data:input});expect(unauthorized.status()).toBe(401);expect(failure.parse(await unauthorized.json())).toEqual({error:"unauthorized"});
    const crossOrigin=await page.request.post(path,{headers:{origin:"https://foreign.example"},data:input});expect(crossOrigin.status()).toBe(403);
    const injected=await page.request.post(path,{headers:{origin},data:{...input,organizationId:randomUUID()}});expect(injected.status()).toBe(400);
    await financialPage.goto(origin+"/en/app");
    let committedId:string|undefined;
    await financialPage.route(origin+path,async route=>{
      const response=await route.fetch();expect(response.status()).toBe(200);const model=createdSchema.parse(await response.json());committedId=model.id;
      expect(model.idempotent).toBe(false);expect(model.total).toEqual({amount:"500.25",currency:"MAD"});await route.abort("failed");
    },{times:1});
    const lost=await financialPage.evaluate(async({path,input})=>{
      try{await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});return false;}catch{return true;}
    },{path,input});expect(lost).toBe(true);expect(committedId).toBeTruthy();
    const replayResponse=await financialPage.request.post(path,{headers:{origin},data:input});expect(replayResponse.status()).toBe(200);expect(replayResponse.headers()["cache-control"]).toBe("private, no-store");
    const replay=createdSchema.parse(await replayResponse.json());expect(replay.id).toBe(committedId);expect(replay.idempotent).toBe(true);expect(replay.lineCount).toBe(1);
    expect(replay.lines[0]).toMatchObject({taskId:f.taskId,personId:f.source.account.personId,assignmentId:f.source.assignment.id,rate:{amount:"500.25",currency:"MAD"}});
    expect(JSON.stringify(replay)).not.toMatch(/idempotencyKey|requestFingerprint|sourceSnapshot|policySnapshot|validation_reason/u);
    const snapshot=()=>withTenant(f.db,f.organizationId,async tx=>({run:await tx.employeeCompensationRun.findUniqueOrThrow({where:{id:replay.id}}),lines:await tx.employeeCompensationRunLine.findMany({where:{runId:replay.id},orderBy:{id:"asc"}})}));
    const original=await snapshot(),readResponse=await financialPage.request.get(path+"/"+replay.id);expect(readResponse.status()).toBe(200);
    expect(employeeCompensationRunViewSchema.parse(await readResponse.json())).toMatchObject({id:replay.id,state:"DRAFT",total:replay.total});
    const forbiddenRead=await anonymous.request.get(path+"/"+replay.id);expect(forbiddenRead.status()).toBe(401);
    const reason="Cancel the actual run while retaining its original source";
    const cancelled=await financialPage.request.post(path+"/"+replay.id+"/cancel",{headers:{origin},data:{reason}});expect(cancelled.status()).toBe(200);
    expect(z.object({id:z.uuid(),idempotent:z.literal(false)}).strict().parse(await cancelled.json()).id).toBe(replay.id);
    const cancelledReplay=await financialPage.request.post(path+"/"+replay.id+"/cancel",{headers:{origin},data:{reason}});expect(cancelledReplay.status()).toBe(200);
    expect(z.object({id:z.uuid(),idempotent:z.literal(true)}).strict().parse(await cancelledReplay.json()).id).toBe(replay.id);
    const finalResponse=await financialPage.request.get(path+"/"+replay.id),final=employeeCompensationRunViewSchema.parse(await finalResponse.json());expect(final.state).toBe("CANCELLED");expect(final.history).toHaveLength(2);
    expect(await snapshot()).toEqual(original);
    await withTenant(f.db,f.organizationId,async tx=>{
      expect(await tx.employeeCompensationRun.count({where:{idempotencyKey:input.idempotencyKey}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:replay.id,action:"finance.employee_compensation_run.created"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:replay.id,action:"finance.employee_compensation_run.cancelled"}})).toBe(1);
    });
    await withTenant(f.db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.source.assignment.id},data:{validTo:new Date()}}));
    const denied=await financialPage.request.get(path+"/"+replay.id);expect(denied.status()).toBe(403);expect(failure.parse(await denied.json())).toEqual({error:"forbidden"});expect(denied.headers()["cache-control"]).toBe("private, no-store");
    expect(await f.facts()).toBe(f.original);
  }finally{await accountContext.close();await anonymous.close();await f.db.$disconnect();}
});
