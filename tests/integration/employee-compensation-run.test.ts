import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync,writeFileSync } from "node:fs";
import { PrismaClient,type Prisma } from "@prisma/client";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { EmployeeCompensationRunRepository } from "@/modules/finance/infrastructure/employee-compensation-run-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { createEmployeeCompensationRun,getEmployeeCompensationRun,cancelEmployeeCompensationRun } from "@/modules/finance/application/employee-compensation-run-service";
import { EmployeeCompensationRunAccessError,EmployeeCompensationRunConflictError,EmployeeCompensationRunPolicyError } from "@/modules/finance/domain/employee-compensation-run";
import { listAuditHistory } from "@/modules/audit/application/audit-service";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { maskedValue } from "@/platform/authz/present";
import { assignTeamRole } from "@/modules/identity/application/team-service";
import { provisionIntegrationRole } from "./support/database-role";
import { employeeCompensationFixtures } from "./support/employee-compensation";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
const fixtures=employeeCompensationFixtures(()=>db,()=>admin);
async function fixture(method:"SELF"|"OFFLINE_SYNC"|"PROXY"="SELF",noLogin=false){
  const f=await fixtures.completedFixture(method,noLogin);
  const actor=await fixtures.reader(f,{permissions:["employee_payable:view","employee_payable:create","employee_payable:void","employee_payable:export","audit_log:view","audit_log:export"]});
  const policy=await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:"staff.compensation_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),
    value:{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:31},reason:"Actual configured compensation run calendar"}));
  const task=await withTenant(db,f.org,tx=>tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}})),on=task.completedAt!.toISOString().slice(0,10);
  return{...f,ctx:{...actor.ctx,personId:f.person.id},runGrant:actor.grant,policy,input:{fromOn:on,toOn:on,currency:"MAD",purpose:"Actual completed work compensation run",reason:"Retain original completed work and contractual amounts",
    idempotencyKey:randomUUID(),jobs:[{taskId:f.taskId,assignmentId:f.contract.id,confirmedAssignment:true as const}]}};
}
async function facts(org:string){return withTenant(db,org,async tx=>({runs:await tx.employeeCompensationRun.count(),lines:await tx.employeeCompensationRunLine.count(),cancellations:await tx.employeeCompensationRunCancellation.count(),
  createdAudits:await tx.auditLog.count({where:{action:"finance.employee_compensation_run.created"}}),cancelAudits:await tx.auditLog.count({where:{action:"finance.employee_compensation_run.cancelled"}}),
  outbox:await tx.outboxEvent.count({where:{type:{in:["EmployeeCompensationRunCreated","EmployeeCompensationRunCancelled"]}}}),journals:await tx.financialTransaction.count(),postings:await tx.posting.count()}));}
async function sourceRows(org:string,runId:string){return withTenant(db,org,async tx=>({run:await tx.employeeCompensationRun.findUniqueOrThrow({where:{id:runId}}),
  lines:await tx.employeeCompensationRunLine.findMany({where:{runId},orderBy:{id:"asc"}})}));}

describe("persisted completed-work compensation runs on real PostgreSQL",()=>{
  beforeAll(async()=>{
    if(!url||!["localhost","127.0.0.1"].includes(new URL(url).hostname))throw Error("Dedicated local PostgreSQL required");
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});
    admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");
    const scoped=new URL(url);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
  });
  afterAll(async()=>{vi.restoreAllMocks();await db?.$disconnect();await admin?.$disconnect();});

  it.each([["SELF",false],["OFFLINE_SYNC",false],["PROXY",false],["PROXY",true]] as const)("retains actual %s work, person-only=%s, through exact create/read/cancel replays",async(method,noLogin)=>{
    const f=await fixture(method,noLogin),created=await createEmployeeCompensationRun(f.ctx,f.input,{db}),before=await sourceRows(f.org,created.id);
    expect(created).toMatchObject({kind:"COMPLETED_WORK_DRAFT",state:"DRAFT",total:{amount:"500.25",currency:"MAD"},lineCount:1,idempotent:false});
    expect(created.lines[0]).toMatchObject({taskId:f.taskId,personId:f.performer.id,assignmentId:f.contract.id,amount:{amount:"500.25",currency:"MAD"}});
    expect(await getEmployeeCompensationRun(f.ctx,{id:created.id},{db})).toMatchObject({id:created.id,total:created.total});
    expect(await createEmployeeCompensationRun(f.ctx,f.input,{db})).toMatchObject({id:created.id,idempotent:true});
    const input={id:created.id,reason:"Cancel this draft while retaining every original source"};
    expect(await cancelEmployeeCompensationRun(f.ctx,input,{db})).toMatchObject({idempotent:false});
    expect(await cancelEmployeeCompensationRun(f.ctx,input,{db})).toMatchObject({idempotent:true});
    const final=await getEmployeeCompensationRun(f.ctx,{id:created.id},{db});expect(final.state).toBe("CANCELLED");expect(final.history).toHaveLength(2);
    expect(await sourceRows(f.org,created.id)).toEqual(before);
    expect(JSON.stringify(final)).not.toMatch(/requestFingerprint|idempotencyKey|sourceSnapshot|policySnapshot|Private staff|Private address|validation_reason/u);
    expect(await facts(f.org)).toEqual({runs:1,lines:1,cancellations:1,createdAudits:1,cancelAudits:1,outbox:2,journals:0,postings:0});
  });

  it("serializes concurrent exact create and cancellation attempts without duplicated source, audit or outbox",async()=>{
    const f=await fixture(),created=await Promise.all(Array.from({length:3},()=>createEmployeeCompensationRun(f.ctx,f.input,{db})));
    expect(new Set(created.map(row=>row.id)).size).toBe(1);expect(created.filter(row=>!row.idempotent)).toHaveLength(1);
    const command={id:created[0].id,reason:"Serialize exact cancellation attempts without rewriting history"};
    const cancelled=await Promise.all(Array.from({length:3},()=>cancelEmployeeCompensationRun(f.ctx,command,{db})));
    expect(cancelled.filter(row=>!row.idempotent)).toHaveLength(1);expect(await facts(f.org)).toMatchObject({runs:1,lines:1,cancellations:1,createdAudits:1,cancelAudits:1,outbox:2,journals:0,postings:0});
  });

  it("binds the original creation and cancellation intent to their actual actor and reason",async()=>{
    const f=await fixture(),created=await createEmployeeCompensationRun(f.ctx,f.input,{db}),before=await facts(f.org);
    await expect(createEmployeeCompensationRun(f.ctx,{...f.input,purpose:"A different immutable intent"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    const colleague=await withTenant(db,f.org,async tx=>{
      const person=await tx.person.create({data:{organizationId:f.org,displayName:"Other explicitly authorized finance colleague"}}),account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}});
      return {person,account};
    });
    const other=await fixtures.reader({...f,...colleague},{permissions:["employee_payable:view","employee_payable:create","employee_payable:void","staff_compensation:view"]});
    await expect(createEmployeeCompensationRun(other.ctx,f.input,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    expect(await facts(f.org)).toEqual(before);
    const command={id:created.id,reason:"Retain the original attributed cancellation reason"};await cancelEmployeeCompensationRun(f.ctx,command,{db});
    await expect(cancelEmployeeCompensationRun(f.ctx,{...command,reason:"Replace the attributed cancellation reason"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    expect(await facts(f.org)).toMatchObject({cancellations:1,cancelAudits:1});
  });

  it("does not assemble a run salary total from individual jobs that merely fit a caller cap",async()=>{
    const f=await fixture(),taskId=await fixtures.completeTask(f),input={...f.input,jobs:[...f.input.jobs,{taskId,assignmentId:f.contract.id,confirmedAssignment:true as const}]};
    const authContext={...f.ctx.authContext,assignments:f.ctx.authContext.assignments!.map(assignment=>assignment.permissions.has("staff_compensation:view")?{...assignment,conditions:{maxAmount:"750.00"}}:assignment)};
    const original=Object.getOwnPropertyDescriptor(ConfigRuleRepository.prototype,"resolveDatedScopeGroups")!.value as ConfigRuleRepository["resolveDatedScopeGroups"],spy=vi.spyOn(ConfigRuleRepository.prototype,"resolveDatedScopeGroups");
    try{await expect(createEmployeeCompensationRun({...f.ctx,authContext},input,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);expect(spy).not.toHaveBeenCalled();}
    finally{spy.mockRestore();}
    expect(Object.getOwnPropertyDescriptor(ConfigRuleRepository.prototype,"resolveDatedScopeGroups")!.value as ConfigRuleRepository["resolveDatedScopeGroups"]).toBe(original);expect(await facts(f.org)).toMatchObject({runs:0,lines:0,createdAudits:0,outbox:0});
    const created=await createEmployeeCompensationRun(f.ctx,input,{db});expect(created.total.amount).toBe("1000.50");
    expect(await createEmployeeCompensationRun(f.ctx,{...input,jobs:[...input.jobs].reverse()},{db})).toMatchObject({id:created.id,idempotent:true});
  });

  it("retains conditional organization salary access for the actual beneficiary",async()=>{
    const f=await fixture(),self=await fixtures.reader({...f,person:f.staff,account:f.staffAccount},{permissions:["employee_payable:view","employee_payable:create","staff_compensation:view"],conditions:{assignedToMe:true,maxAmount:"500.25"}});
    const root=await fixtures.reader({...f,person:f.staff,account:f.staffAccount},{permissions:["employee_payable:view","employee_payable:create"]});
    const created=await createEmployeeCompensationRun(root.ctx,f.input,{db});expect(created.total.amount).toBe("500.25");
    expect(self.ctx.authContext.personId).toBe(f.staff.id);expect(await getEmployeeCompensationRun(root.ctx,{id:created.id},{db})).toMatchObject({id:created.id});
  });

  it("requires independent salary view before reading private run configuration",async()=>{
    const f=await fixture(),authContext={...f.ctx.authContext,permissions:new Set([...f.ctx.authContext.permissions].filter(key=>key!=="staff_compensation:view"))};
    const spy=vi.spyOn(ConfigRuleRepository.prototype,"resolveDatedScopeGroups");
    try{await expect(createEmployeeCompensationRun({...f.ctx,authContext},f.input,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
    expect(await facts(f.org)).toMatchObject({runs:0,lines:0,createdAudits:0,outbox:0});
  });

  it("rolls back every stored source and receipt when actual run authority expires after deferred guards",async()=>{
    const f=await fixture(),original=Object.getOwnPropertyDescriptor(EmployeeCompensationRunRepository.prototype,"flushGuards")!.value as EmployeeCompensationRunRepository["flushGuards"];
    const spy=vi.spyOn(EmployeeCompensationRunRepository.prototype,"flushGuards").mockImplementation(async function(this:EmployeeCompensationRunRepository){await original.call(this);
      await withTenant(db,f.org,tx=>tx.$executeRaw`UPDATE role_assignment SET valid_to=clock_timestamp() WHERE organization_id=${f.org}::uuid AND id=${f.runGrant.id}::uuid`);});
    try{await expect(createEmployeeCompensationRun(f.ctx,f.input,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);}finally{spy.mockRestore();}
    expect(await facts(f.org)).toMatchObject({runs:0,lines:0,cancellations:0,createdAudits:0,outbox:0,journals:0,postings:0});
  });

  it("rejects a run period outside its actual configured earning window",async()=>{
    const f=await fixture();await expect(createEmployeeCompensationRun(f.ctx,{...f.input,fromOn:"2020-01-01",toOn:"2020-01-01"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunPolicyError);
    expect(await facts(f.org)).toMatchObject({runs:0,lines:0,createdAudits:0,outbox:0});
  });

  it("isolates source, read, cancellation and raw cross-tenant access",async()=>{
    const a=await fixture(),b=await fixture(),created=await createEmployeeCompensationRun(a.ctx,a.input,{db});
    await expect(getEmployeeCompensationRun(b.ctx,{id:created.id},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    await expect(cancelEmployeeCompensationRun(b.ctx,{id:created.id,reason:"Foreign tenant must never cancel this run"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    await expect(createEmployeeCompensationRun(b.ctx,{...b.input,jobs:a.input.jobs},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    expect(await withTenant(db,b.org,tx=>tx.employeeCompensationRun.findMany({where:{id:created.id}}))).toEqual([]);
    expect(await facts(b.org)).toMatchObject({runs:0,lines:0,cancellations:0,createdAudits:0,outbox:0});
  });

  it("protects immutable run and source history at the actual SQL boundary",async()=>{
    const f=await fixture(),created=await createEmployeeCompensationRun(f.ctx,f.input,{db}),before=await sourceRows(f.org,created.id);
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationRun.update({where:{id:created.id},data:{purpose:"Rewrite original compensation intent"}}))).rejects.toThrow();
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationRunLine.deleteMany({where:{runId:created.id}}))).rejects.toThrow();
    expect(await sourceRows(f.org,created.id)).toEqual(before);
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationRun.create({data:{organizationId:f.org,createdBy:f.ctx.actorId,idempotencyKey:randomUUID(),requestFingerprint:"0".repeat(64),
      fromOn:before.run.fromOn,toOn:before.run.toOn,timezone:before.run.timezone,currency:before.run.currency,purpose:"Incomplete raw run",reason:"Incomplete raw run must never persist",
      policyRuleId:before.run.policyRuleId,policySnapshot:before.run.policySnapshot as Prisma.InputJsonObject}}))).rejects.toThrow(/compensation run requires/u);
    expect(await facts(f.org)).toMatchObject({runs:1,lines:1,createdAudits:1,outbox:1});
  });

  it("denies source append and a duplicate creation audit without rewriting the original run",async()=>{
    const f=await fixture(),first=await createEmployeeCompensationRun(f.ctx,f.input,{db}),taskId=await fixtures.completeTask(f);
    const second=await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID(),jobs:[{taskId,assignmentId:f.contract.id,confirmedAssignment:true}]},{db});
    const before=await sourceRows(f.org,first.id),other=(await sourceRows(f.org,second.id)).lines[0];
    await expect(withTenant(db,f.org,async tx=>{
      await tx.employeeCompensationRunLine.create({data:{...other,id:undefined,runId:first.id,sourceSnapshot:other.sourceSnapshot as Prisma.InputJsonObject}});
      await writeAuditEvent(tx,{organizationId:f.org,actorId:f.ctx.actorId,action:"finance.employee_compensation_run.created",resourceType:"employee_compensation_run",resourceId:first.id,
        after:{runId:first.id,kind:"COMPLETED_WORK_DRAFT",lineCount:2,total:{amount:"1000.50",currency:"MAD"}},reason:before.run.reason,requestId:randomUUID(),occurredAt:await new FinanceRepository(tx,f.org).clock()});
    })).rejects.toThrow(/compensation run requires/u);
    expect(await sourceRows(f.org,first.id)).toEqual(before);expect(await facts(f.org)).toMatchObject({runs:2,lines:2,createdAudits:2,outbox:2});
  });

  it("uses actual run and beneficiary authority when presenting financial audit history",async()=>{
    const f=await fixture(),created=await createEmployeeCompensationRun(f.ctx,f.input,{db});
    const allowed=await listAuditHistory({...f.ctx,personId:f.person.id},{resourceType:"employee_compensation_run"},{db});
    expect(allowed.rows.some(row=>row.resourceId===created.id&&JSON.stringify(row.after).includes("500.25"))).toBe(true);
    const auditOnly=await fixtures.reader(f,{permissions:["audit_log:view"]});
    const authContext={...auditOnly.ctx.authContext,permissions:new Set(["audit_log:view"]),assignments:auditOnly.ctx.authContext.assignments!.filter(assignment=>assignment.roleKey===undefined||!assignment.permissions.has("employee_payable:view")&&!assignment.permissions.has("staff_compensation:view"))};
    const denied=await listAuditHistory({...auditOnly.ctx,authContext,personId:f.person.id},{resourceType:"employee_compensation_run"},{db});
    expect(denied.rows.find(row=>row.resourceId===created.id)?.after).toBe(maskedValue);expect(JSON.stringify(denied.rows)).not.toContain("500.25");
  });

  it("rolls back stored evidence when the actual earning policy changes after deferred guards",async()=>{
    const f=await fixture(),original=Object.getOwnPropertyDescriptor(EmployeeCompensationRunRepository.prototype,"flushGuards")!.value as EmployeeCompensationRunRepository["flushGuards"];
    const spy=vi.spyOn(EmployeeCompensationRunRepository.prototype,"flushGuards").mockImplementation(async function(this:EmployeeCompensationRunRepository){
      await original.call(this);await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:"staff.compensation_runs",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),
        value:{earning_date:"RECORDED_COMPLETION",timezone:"UTC",max_period_days:30},reason:"Actual concurrent replacement earning policy"}));
    });
    try{await expect(createEmployeeCompensationRun(f.ctx,f.input,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunPolicyError);}finally{spy.mockRestore();}
    expect(await facts(f.org)).toMatchObject({runs:0,lines:0,createdAudits:0,outbox:0,journals:0,postings:0});
  });

  it("rejects a property source that moves city after its actual private configuration read",async()=>{
    const f=await fixture(),replacement=await withTenant(db,f.org,tx=>tx.city.create({data:{organizationId:f.org,regionId:f.region.id,name:"Actual changed salary source city"}}));
    const original=Object.getOwnPropertyDescriptor(ConfigRuleRepository.prototype,"resolveDatedScopeGroups")!.value as ConfigRuleRepository["resolveDatedScopeGroups"];let changed=false;
    const spy=vi.spyOn(ConfigRuleRepository.prototype,"resolveDatedScopeGroups").mockImplementation(async function(this:ConfigRuleRepository,...args){
      const result=await original.apply(this,args);if(!changed&&args[0]==="staff.compensation"){changed=true;await withTenant(db,f.org,tx=>tx.property.update({where:{id:f.property.id},data:{cityId:replacement.id}}));}return result;
    });
    try{await expect(createEmployeeCompensationRun(f.ctx,f.input,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);expect(changed).toBe(true);}finally{spy.mockRestore();}
    expect(await facts(f.org)).toMatchObject({runs:0,lines:0,createdAudits:0,outbox:0});
  });

  it("persists actual completed work across 500 properties with constant source query count and paginated reads",async()=>{
    const f=await fixture(),contract=await assignTeamRole(f.ctx,{personId:f.staff.id,roleId:f.role.id,scopeType:"organization",scopeId:null,validFrom:"2020-01-01",validTo:null,
      assignedToMe:false,reason:"Actual portfolio-wide per-job contract"},{db});
    await fixtures.rate(f,"PER_JOB","500.25",0,"2020-01-01",contract.id);
    const properties=await withTenant(db,f.org,tx=>tx.property.createManyAndReturn({data:Array.from({length:500},(_,index)=>({organizationId:f.org,name:`Actual run capacity villa ${index}`,
      addressLine1:"Dedicated local capacity fixture",city:f.city.name,cityId:f.city.id,regionId:f.region.id,timezone:"UTC",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}))}));
    const jobs:typeof f.input.jobs=[];
    for(const property of properties){const taskId=await fixtures.completeTask({...f,property});jobs.push({taskId,assignmentId:contract.id,confirmedAssignment:true});}
    const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";
    const measured=new PrismaClient({datasourceUrl:scoped.toString(),log:[{emit:"event",level:"query"}]});let queryCount=0;measured.$on("query",()=>{queryCount++;});
    try{
      const measure=async(selected:typeof jobs)=>{await withTenant(measured,f.org,tx=>tx.$queryRaw`SELECT 1`);queryCount=0;const start=performance.now();
        const result=await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID(),jobs:selected},{db:measured});
        await withTenant(measured,f.org,tx=>tx.$queryRaw`SELECT 1`);return{result,queries:queryCount,durationMs:performance.now()-start};};
      const one=await measure([{taskId:f.taskId,assignmentId:contract.id,confirmedAssignment:true}]),many=await measure(jobs);
      expect(one.result.total.amount).toBe("500.25");expect(many.result.total.amount).toBe("250125.00");expect(many.result.lineCount).toBe(500);
      expect(many.queries).toBe(one.queries);
      const first=await getEmployeeCompensationRun(f.ctx,{id:many.result.id},{db});expect(first.lines).toHaveLength(50);expect(first.nextCursor).toBeTruthy();
      const next=await getEmployeeCompensationRun(f.ctx,{id:many.result.id,after:first.nextCursor!},{db});expect(next.lines).toHaveLength(50);
      expect(new Set([...first.lines,...next.lines].map(line=>line.id)).size).toBe(100);expect(next.total.amount).toBe("250125.00");
      expect(await facts(f.org)).toMatchObject({runs:2,lines:501,createdAudits:2,outbox:2,journals:0,postings:0});
      const measurement={actualCompletedProperties:500,sourceQueriesOne:one.queries,sourceQueries500:many.queries,singleMs:Math.round(one.durationMs),portfolioMs:Math.round(many.durationMs),noFinancialMovements:true};
      if(process.env.AUT_RECORD_RUN_CAPACITY==="1"){mkdirSync(".tmp",{recursive:true});writeFileSync(".tmp/employee-run-capacity-500.json",JSON.stringify(measurement,null,2),{flag:"wx"});}
      console.info(JSON.stringify(measurement));
    }finally{await measured.$disconnect();}
  });
});
