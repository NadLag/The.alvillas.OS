import { randomUUID } from "node:crypto";
import { z } from "zod";
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
import { saveTeamCompensation } from "@/modules/identity/application/team-service";
import { decryptSecret } from "@/platform/auth/secret-encryption";
import { getEmployeeCompensationRunEditor,listEmployeeCompensationWork } from "@/modules/finance/application/employee-compensation-picker";
import { EmployeeCompensationPickerRepository } from "@/modules/finance/infrastructure/employee-compensation-picker-repository";
import { recoverEmployeeCompensationRun } from "@/modules/finance/application/employee-compensation-run-recovery";
import { submitEmployeeCompensation,withdrawEmployeeCompensation,getEmployeeCompensationSubmission } from "@/modules/finance/application/employee-compensation-submission";
import { EmployeeCompensationClaimRepository } from "@/modules/finance/infrastructure/employee-compensation-claim-repository";
import { getApproval,decideApproval } from "@/platform/approvals/approval-service";
import { ApprovalAccessError,ApprovalConflictError } from "@/platform/approvals/approval";
import { authContextForAccount } from "@/platform/authz/account-context";
import { requestEmployeeCompensationSubmission,executeEmployeeCompensationSubmissionReference,getEmployeeCompensationSubmissionRequest,failEmployeeCompensationSubmissionReference,employeeCompensationSubmissionRequested } from "@/modules/finance/application/employee-compensation-submission-requests";
import { provisionIntegrationRole } from "./support/database-role";
import { employeeCompensationFixtures } from "./support/employee-compensation";
import { getEmployeeCompensationRunDetail } from "@/modules/finance/application/employee-compensation-run-detail";
import { listEmployeeCompensationRuns } from "@/modules/finance/application/employee-compensation-run-list";
import { prepareEmployeeCompensationClaimPolicy } from "@/modules/finance/application/employee-compensation-claim-policy";
import { EmployeeCompensationClaimSourceError } from "@/modules/finance/domain/employee-compensation-claim";

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
async function claimFixture(method:"SELF"|"OFFLINE_SYNC"|"PROXY"="SELF",noLogin=false){
  const f=await fixture(method,noLogin),run=await createEmployeeCompensationRun(f.ctx,f.input,{db});
  await fixtures.reader(f,{permissions:["employee_payable:edit"]});
  const financial=await fixtures.reader(f,{permissions:["financial_transaction:view","expense:view","expense:approve","expense:reject"]});
  const costOwner=await withTenant(db,f.org,async tx=>{
    const owner=await tx.owner.create({data:{organizationId:f.org,displayName:"Actual completed work property owner"}});
    await tx.propertyOwner.create({data:{organizationId:f.org,propertyId:f.property.id,ownerId:owner.id}});
    const rules=new ConfigRuleRepository(tx,f.org);
    await rules.createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),value:{default_treatment:"ALVILLAS_PAID"},reason:"Explicit configured employer work cost allocation"});
    await rules.createVersion({key:"finance.approval_thresholds",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{thresholds:[]},reason:"Explicit configured initial employee work review"});
    return owner;
  });
  return{...f,run,costOwner,claimActor:financial.ctx,financialGrant:financial.grant,claimInput:{runId:run.id,costOn:run.fromOn,emergency:false,
    costs:run.lines.map(line=>({runLineId:line.id,category:"staff",costCenter:null,note:"Review the original completed work contractual cost"}))}};
}

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

  it("prepares actual employee work costs through the canonical property allocation engine without posting or changing the original run",async()=>{
    const f=await claimFixture(),before=await sourceRows(f.org,f.run.id);
    const plan=await withTenant(db,f.org,async tx=>{const prepared=await prepareEmployeeCompensationClaimPolicy(f.claimActor,f.claimInput,tx);await prepared.recheck();return prepared;});
    expect(plan.total).toEqual({amount:"500.25",currency:"MAD"});expect(plan.costs).toHaveLength(1);expect(plan.stages).toEqual([]);
    expect(plan.costs[0]).toMatchObject({runLineId:f.run.lines[0].id,personId:f.performer.id,propertyId:f.property.id,completionEventId:f.run.lines[0].completionEventId,
      amount:{amount:"500.25",currency:"MAD"},policy:{sourceKind:"employee_compensation_run_line",allocation:{owner:{amount:"0.00",currency:"MAD"},alvillas:{amount:"500.25",currency:"MAD"},guest:{amount:"0.00",currency:"MAD"}}}});
    expect(await sourceRows(f.org,f.run.id)).toEqual(before);expect(await facts(f.org)).toMatchObject({runs:1,lines:1,journals:0,postings:0});
  });

  it("submits original positive work costs once under concurrent retries without recognizing or paying them",async()=>{
    const f=await claimFixture(),before=await sourceRows(f.org,f.run.id),input={...f.claimInput,idempotencyKey:randomUUID(),reason:"Submit the actual completed-work contractual costs"};
    const results=await Promise.all(Array.from({length:3},()=>submitEmployeeCompensation(f.claimActor,input,{db})));
    expect(new Set(results.map(result=>result.id)).size).toBe(1);expect(results.filter(result=>!result.idempotent)).toHaveLength(1);
    expect(results[0]).toMatchObject({runId:f.run.id,state:"APPROVED",claimCount:1,costCount:1,approvalId:null});
    await withTenant(db,f.org,async tx=>{const saved=await new EmployeeCompensationClaimRepository(tx,f.org).find(results[0].id);expect(saved?.costs[0]).toMatchObject({runLineId:f.run.lines[0].id,completionEventId:f.run.lines[0].completionEventId,currency:"MAD",claim:{personId:f.performer.id}});
      expect(saved?.costs[0].amount.toFixed(2)).toBe("500.25");expect(await tx.employeeCompensationSubmission.count()).toBe(1);expect(await tx.employeeCompensationClaim.count()).toBe(1);
      expect(await tx.auditLog.count({where:{action:"finance.employee_compensation.submitted"}})).toBe(1);expect(await tx.outboxEvent.count({where:{type:"EmployeeCompensationSubmitted"}})).toBe(1);});
    await expect(submitEmployeeCompensation(f.claimActor,{...input,reason:"Changed original proposal reason"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    await expect(submitEmployeeCompensation(f.claimActor,{...input,amount:"1.00"},{db})).rejects.toBeInstanceOf(z.ZodError);
    expect(await sourceRows(f.org,f.run.id)).toEqual(before);expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it.each([["SELF",false],["OFFLINE_SYNC",false],["PROXY",false],["PROXY",true]] as const)("binds employee claims to the actual %s performer, including person-only=%s",async(method,noLogin)=>{
    const f=await claimFixture(method,noLogin),created=await submitEmployeeCompensation(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Retain the actual completed-work beneficiary independently from validation"},{db}),detail=await getEmployeeCompensationSubmission(f.claimActor,{id:created.id},{db});
    expect(detail.costs[0]).toMatchObject({personId:f.performer.id,completionEventId:f.run.lines[0].completionEventId,amount:{amount:"500.25",currency:"MAD"}});
    expect(await withTenant(db,f.org,tx=>tx.employeeCompensationClaim.findUniqueOrThrow({where:{id:detail.costs[0].claimId}}))).toMatchObject({personId:f.performer.id});
    if(method==="PROXY")expect(f.performer.id).not.toBe(f.person.id);if(noLogin)expect(await withTenant(db,f.org,tx=>tx.userAccount.count({where:{personId:f.performer.id}}))).toBe(0);
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("uses the same actual run financial-record scope for employee proposal detail and audit disclosure",async()=>{
    const f=await claimFixture(),created=await submitEmployeeCompensation(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Bind employee source and audit to this actual run authority"},{db});
    const scoped={...f.claimActor,authContext:{...f.claimActor.authContext,assignments:f.claimActor.authContext.assignments!.flatMap(assignment=>assignment.permissions.has("employee_payable:view")?
      [{...assignment,permissions:new Set([...assignment.permissions].filter(key=>key!=="employee_payable:view"))},{...assignment,permissions:new Set(["employee_payable:view"]),scope:{organizationId:f.org,scopeType:"financial_record" as const,scopeId:f.run.id}}]:[assignment])}};
    expect((await getEmployeeCompensationSubmission(scoped,{id:created.id},{db})).total.amount).toBe("500.25");
    const allowed=await listAuditHistory({...scoped,personId:f.person.id},{resourceType:"employee_compensation_submission",resourceId:created.id},{db});
    expect(allowed.rows.find(row=>row.action==="finance.employee_compensation.submitted")?.after).toMatchObject({submissionId:created.id,total:{amount:"500.25",currency:"MAD"}});
    const denied={...scoped,authContext:{...scoped.authContext,assignments:scoped.authContext.assignments.map(assignment=>assignment.scope.scopeType==="financial_record"?{...assignment,scope:{...assignment.scope,scopeId:randomUUID()}}:assignment)}};
    await expect(getEmployeeCompensationSubmission(denied,{id:created.id},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    const masked=await listAuditHistory({...denied,personId:f.person.id},{resourceType:"employee_compensation_submission",resourceId:created.id},{db});expect(masked.rows.find(row=>row.action==="finance.employee_compensation.submitted")?.after).toBe(maskedValue);
  });

  it("retains the actual run creator when financial source access is restricted to assigned records",async()=>{
    const f=await claimFixture(),caller={...f.claimActor,authContext:{...f.claimActor.authContext,assignments:f.claimActor.authContext.assignments!.flatMap(assignment=>assignment.permissions.has("financial_transaction:view")?
      [{...assignment,permissions:new Set([...assignment.permissions].filter(key=>key!=="financial_transaction:view"))},{...assignment,permissions:new Set(["financial_transaction:view"]),conditions:{...assignment.conditions,assignedToMe:true}}]:[assignment])}};
    const queued=await requestEmployeeCompensationSubmission(caller,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Retain original assigned financial source facts during queued work"},{db});expect(queued.state).toBe("PENDING");
    const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:queued.requestId}}}));
    const result=await executeEmployeeCompensationSubmissionReference({organizationId:f.org,outboxEventId:event.id},{db});expect(result.state).toBe("SUCCEEDED");expect(result.submissionId).toBeTruthy();
    expect((await getEmployeeCompensationSubmission(caller,{id:result.submissionId!},{db})).total.amount).toBe("500.25");expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
    const other=await withTenant(db,f.org,async tx=>{const person=await tx.person.create({data:{organizationId:f.org,displayName:"Different assigned-record financial reviewer"}});return{person,account:await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}})};});
    await fixtures.reader({...f,...other},{permissions:["employee_payable:view","employee_payable:edit","staff_compensation:view"]});
    const restricted=await fixtures.reader({...f,...other},{permissions:["financial_transaction:view"],conditions:{assignedToMe:true}});
    await expect(getEmployeeCompensationSubmission(restricted.ctx,{id:result.submissionId!},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
  });

  it("queues immutable employee submission intent and commits one source with one success outcome across worker redeliveries",async()=>{
    const f=await claimFixture(),input={...f.claimInput,idempotencyKey:randomUUID(),reason:"Queue the actual completed-work cost review intent"},before=await sourceRows(f.org,f.run.id);
    const attempts=await Promise.all(Array.from({length:3},()=>requestEmployeeCompensationSubmission(f.claimActor,input,{db})));expect(new Set(attempts.map(result=>result.requestId)).size).toBe(1);expect(attempts.filter(result=>!result.idempotent)).toHaveLength(1);
    expect(attempts[0]).toMatchObject({state:"PENDING",submissionId:null,failureCode:null});expect(JSON.stringify(attempts)).not.toMatch(/authorizationCap|costs|500\.25|requestFingerprint/u);
    expect(await withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.count())).toBe(0);
    const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:attempts[0].requestId}}}));
    expect(event.payload).toEqual({requestId:attempts[0].requestId});const reference={organizationId:f.org,outboxEventId:event.id};
    const results=await Promise.all(Array.from({length:2},()=>executeEmployeeCompensationSubmissionReference(reference,{db})));expect(new Set(results.map(result=>result.submissionId)).size).toBe(1);expect(results.filter(result=>!result.idempotent)).toHaveLength(1);
    expect(results[0]).toMatchObject({state:"SUCCEEDED",failureCode:null});expect(await getEmployeeCompensationSubmissionRequest(f.claimActor,{id:attempts[0].requestId},{db})).toMatchObject({state:"SUCCEEDED",submissionId:results[0].submissionId});
    const detail=await getEmployeeCompensationSubmission(f.claimActor,{id:results[0].submissionId!},{db});expect(detail).toMatchObject({state:"APPROVED",total:{amount:"500.25",currency:"MAD"},canWithdraw:true,costCount:1,claimCount:1});
    expect(detail.costs[0]).toMatchObject({personId:f.performer.id,runLineId:f.run.lines[0].id,amount:{amount:"500.25",currency:"MAD"},allocation:{alvillas:{amount:"500.25",currency:"MAD"}}});
    expect(JSON.stringify(detail)).not.toMatch(/policySnapshot|authorizationCap|requestFingerprint|idempotencyKey|sourceSnapshot|contractRule/u);
    await withTenant(db,f.org,async tx=>{expect(await tx.employeeCompensationSubmission.count()).toBe(1);expect(await tx.employeeCompensationSubmissionRequest.count()).toBe(1);expect(await tx.employeeCompensationSubmissionOutcome.count()).toBe(1);
      expect(await tx.auditLog.count({where:{action:"finance.employee_compensation.submission_completed"}})).toBe(1);});
    await expect(withTenant(db,f.org,tx=>tx.outboxEvent.update({where:{id:event.id},data:{payload:{requestId:randomUUID()}}}))).rejects.toThrow(/immutable/u);
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationSubmissionRequest.update({where:{id:attempts[0].requestId},data:{authorizationCap:{}}}))).rejects.toThrow();
    await withdrawEmployeeCompensation(f.claimActor,{id:results[0].submissionId!,reason:"Retain historical work and request after withdrawal"},{db});
    await cancelEmployeeCompensationRun(f.claimActor,{id:f.run.id,reason:"Cancel the original run after its proposal withdrawal"},{db});
    expect(await getEmployeeCompensationSubmissionRequest(f.claimActor,{id:attempts[0].requestId},{db})).toMatchObject({state:"SUCCEEDED",submissionId:results[0].submissionId});
    const history=await getEmployeeCompensationSubmission(f.claimActor,{id:results[0].submissionId!},{db});expect(history.state).toBe("WITHDRAWN");expect(history.history.map(event=>event.action)).toEqual(["SUBMITTED","WITHDRAWN"]);
    expect(await sourceRows(f.org,f.run.id)).toEqual(before);expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("rechecks queued caller restrictions and current stored financial authority before creating employee claims",async()=>{
    const f=await claimFixture(),input={...f.claimInput,idempotencyKey:randomUUID(),reason:"Require current authority for deferred employee review"},queued=await requestEmployeeCompensationSubmission(f.claimActor,input,{db});
    const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:queued.requestId}}}));
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.financialGrant.id},data:{validTo:new Date("2020-01-02")}}));
    const reference={organizationId:f.org,outboxEventId:event.id};expect(await executeEmployeeCompensationSubmissionReference(reference,{db})).toMatchObject({state:"DENIED",failureCode:"ACCESS_DENIED",submissionId:null,idempotent:false});
    expect(await executeEmployeeCompensationSubmissionReference(reference,{db})).toMatchObject({state:"DENIED",idempotent:true});
    await expect(getEmployeeCompensationSubmissionRequest(f.claimActor,{id:queued.requestId},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    expect(await withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.count())).toBe(0);expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("retains terminal worker failure and rejects forged or foreign employee submission references",async()=>{
    const f=await claimFixture(),other=await claimFixture(),queued=await requestEmployeeCompensationSubmission(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Keep an attributed exhausted employee submission outcome"},{db});
    const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:queued.requestId}}}));
    await expect(executeEmployeeCompensationSubmissionReference({organizationId:other.org,outboxEventId:event.id},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    await expect(executeEmployeeCompensationSubmissionReference({organizationId:f.org,outboxEventId:event.id},{db,eventType:"SupplierInvoiceRecognitionRequested"})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    await expect(getEmployeeCompensationSubmissionRequest(other.claimActor,{id:queued.requestId},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    const reference={organizationId:f.org,outboxEventId:event.id};expect(await failEmployeeCompensationSubmissionReference(reference,{db})).toMatchObject({state:"FAILED",failureCode:"EXECUTION_UNAVAILABLE",idempotent:false});
    expect(await executeEmployeeCompensationSubmissionReference(reference,{db})).toMatchObject({state:"FAILED",idempotent:true});expect(await withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.count())).toBe(0);
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("retains the captured caller expiry despite wider stored employee submission authority",async()=>{
    const f=await claimFixture(),now=await withTenant(db,f.org,tx=>new FinanceRepository(tx,f.org).clock()),expires=new Date(now.getTime()+5000),caller={...f.claimActor,authContext:{...f.claimActor.authContext,
      assignments:f.claimActor.authContext.assignments!.map(assignment=>({...assignment,validTo:expires}))}};
    const queued=await requestEmployeeCompensationSubmission(caller,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Retain original restricted caller validity through deferred work"},{db});
    await withTenant(db,f.org,tx=>tx.$executeRaw`SELECT pg_sleep(5.1)`);
    const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:queued.requestId}}}));
    expect(await executeEmployeeCompensationSubmissionReference({organizationId:f.org,outboxEventId:event.id},{db})).toMatchObject({state:"DENIED",failureCode:"ACCESS_DENIED"});
    expect((await authContextForAccount(f.org,f.account.id,{db})).permissions.has("employee_payable:edit")).toBe(true);
    expect(await withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.count())).toBe(0);expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("returns a durable source conflict when the actual earning contract changes before queued submission",async()=>{
    const f=await claimFixture(),queued=await requestEmployeeCompensationSubmission(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Queue only this saved completed-work earning expectation"},{db});
    await saveTeamCompensation(f.ctx,{assignmentId:f.contract.id,expectedVersion:1,mode:"PER_JOB",amount:"750.00",currency:"MAD",effectiveFrom:"2020-01-02",reason:"Actual changed earning terms require a fresh expectation"},{db});
    const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:queued.requestId}}}));
    expect(await executeEmployeeCompensationSubmissionReference({organizationId:f.org,outboxEventId:event.id},{db})).toMatchObject({state:"CONFLICT",failureCode:"SOURCE_CHANGED",submissionId:null});
    expect(await withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.count())).toBe(0);expect((await getEmployeeCompensationRun(f.ctx,{id:f.run.id},{db})).total.amount).toBe("500.25");
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("reserves completed work across separate drafts and releases it only through an attributed withdrawal",async()=>{
    const f=await claimFixture(),input={...f.claimInput,idempotencyKey:randomUUID(),reason:"Reserve this original work for employee cost review"},first=await submitEmployeeCompensation(f.claimActor,input,{db});
    const second=await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID()},{db}),retry={...input,runId:second.id,idempotencyKey:randomUUID(),costs:second.lines.map(line=>({...input.costs[0],runLineId:line.id}))};
    await expect(submitEmployeeCompensation(f.claimActor,retry,{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    await expect(cancelEmployeeCompensationRun(f.claimActor,{id:f.run.id,reason:"Must retain work while its employee claim is active"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    const withdrawal={id:first.id,reason:"Withdraw the cost proposal before replacement review"};expect(await withdrawEmployeeCompensation(f.claimActor,withdrawal,{db})).toMatchObject({state:"WITHDRAWN",idempotent:false});
    expect(await withdrawEmployeeCompensation(f.claimActor,withdrawal,{db})).toMatchObject({id:first.id,idempotent:true});
    await expect(withdrawEmployeeCompensation(f.claimActor,{...withdrawal,reason:"Different withdrawal intent"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunConflictError);
    expect(await submitEmployeeCompensation(f.claimActor,retry,{db})).toMatchObject({runId:second.id,state:"APPROVED",idempotent:false});
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("protects employee claims and cost sources against raw rewrites, late append and incomplete submissions",async()=>{
    const f=await claimFixture(),created=await submitEmployeeCompensation(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Persist actual immutable employee cost sources"},{db});
    const saved=await withTenant(db,f.org,tx=>new EmployeeCompensationClaimRepository(tx,f.org).find(created.id));expect(saved).toBeTruthy();const cost=saved!.costs[0];
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationCost.update({where:{id:cost.id},data:{amount:"1"}}))).rejects.toThrow();
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationClaim.deleteMany({where:{submissionId:created.id}}))).rejects.toThrow();
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationCost.create({data:{organizationId:f.org,submissionId:created.id,claimId:cost.claimId,runLineId:cost.runLineId,
      completionEventId:cost.completionEventId,propertyId:cost.propertyId,reservationId:cost.reservationId,amount:cost.amount,currency:cost.currency,category:cost.category,costCenter:cost.costCenter,note:cost.note,timezone:cost.timezone,policySnapshot:cost.policySnapshot as Prisma.InputJsonObject}}))).rejects.toThrow(/original submission/u);
    await expect(withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.create({data:{organizationId:f.org,runId:f.run.id,submittedBy:f.account.id,idempotencyKey:randomUUID(),requestFingerprint:"0".repeat(64),costOn:saved!.costOn,
      emergency:false,reason:"Incomplete submission must never be admitted",snapshot:saved!.snapshot as Prisma.InputJsonObject}}))).rejects.toThrow(/every original positive source/u);
    expect(await withTenant(db,f.org,tx=>tx.employeeCompensationSubmission.count())).toBe(1);expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("rolls back the complete employee submission when financial authority expires after deferred source guards",async()=>{
    const f=await claimFixture(),original=Object.getOwnPropertyDescriptor(EmployeeCompensationClaimRepository.prototype,"flushGuards")!.value as EmployeeCompensationClaimRepository["flushGuards"];
    const spy=vi.spyOn(EmployeeCompensationClaimRepository.prototype,"flushGuards").mockImplementation(async function(this:EmployeeCompensationClaimRepository){await original.call(this);
      await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.financialGrant.id},data:{validTo:new Date("2020-01-02")}}));});
    try{await expect(submitEmployeeCompensation(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Require final current employee cost financial authority"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);}finally{spy.mockRestore();}
    await withTenant(db,f.org,async tx=>{expect(await tx.employeeCompensationSubmission.count()).toBe(0);expect(await tx.employeeCompensationClaim.count()).toBe(0);expect(await tx.employeeCompensationCost.count()).toBe(0);expect(await tx.auditLog.count({where:{action:"finance.employee_compensation.submitted"}})).toBe(0);expect(await tx.outboxEvent.count({where:{type:"EmployeeCompensationSubmitted"}})).toBe(0);});
    expect(await facts(f.org)).toMatchObject({runs:1,lines:1,journals:0,postings:0});
  });

  it("requires actual salary and independent financial-source view before resolving employee work cost configuration",async()=>{
    const f=await claimFixture(),spy=vi.spyOn(ConfigRuleRepository.prototype,"scopedSnapshot");
    try{for(const key of["staff_compensation:view","financial_transaction:view"]){
      const denied={...f.claimActor,authContext:{...f.claimActor.authContext,permissions:new Set([...f.claimActor.authContext.permissions].filter(permission=>permission!==key))}};
      await expect(withTenant(db,f.org,tx=>prepareEmployeeCompensationClaimPolicy(denied,f.claimInput,tx))).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    }expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("requires a fresh expected run when its original earning contract has changed before claim submission",async()=>{
    const f=await claimFixture(),before=await sourceRows(f.org,f.run.id);
    await saveTeamCompensation({...f.ctx,personId:f.person.id},{assignmentId:f.contract.id,expectedVersion:1,mode:"PER_JOB",amount:"750.00",currency:"MAD",effectiveFrom:"2020-01-02",reason:"Actual revised earning terms before proposing a claim"},{db});
    await expect(withTenant(db,f.org,tx=>prepareEmployeeCompensationClaimPolicy(f.claimActor,f.claimInput,tx))).rejects.toBeInstanceOf(EmployeeCompensationClaimSourceError);
    expect(await sourceRows(f.org,f.run.id)).toEqual(before);expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("checks the complete employee claim amount against financial-source caps before reading cost rules",async()=>{
    const f=await claimFixture(),taskId=await fixtures.completeTask(f),run=await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID(),jobs:[...f.input.jobs,{taskId,assignmentId:f.contract.id,confirmedAssignment:true}]},{db});
    const capped={...f.claimActor,authContext:{...f.claimActor.authContext,assignments:f.claimActor.authContext.assignments!.map(assignment=>assignment.permissions.has("financial_transaction:view")?{...assignment,conditions:{maxAmount:"750.00"}}:assignment)}};
    const input={...f.claimInput,runId:run.id,costs:run.lines.map(line=>({...f.claimInput.costs[0],runLineId:line.id}))},spy=vi.spyOn(ConfigRuleRepository.prototype,"scopedSnapshot");
    try{await expect(withTenant(db,f.org,tx=>prepareEmployeeCompensationClaimPolicy(capped,input,tx))).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("rejects a changed allocation policy or revoked financial grant during the retained employee claim recheck",async()=>{
    const f=await claimFixture();
    await expect(withTenant(db,f.org,async tx=>{
      const plan=await prepareEmployeeCompensationClaimPolicy(f.claimActor,f.claimInput,tx);
      await withTenant(db,f.org,other=>new ConfigRuleRepository(other,f.org).createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:f.property.id,
        effectiveFrom:new Date("2020-01-02"),value:{default_treatment:"OWNER_PAID"},reason:"Actual cost allocation change after original work plan"}));
      await plan.recheck();
    })).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    await expect(withTenant(db,f.org,async tx=>{
      const plan=await prepareEmployeeCompensationClaimPolicy(f.claimActor,f.claimInput,tx);
      await withTenant(db,f.org,other=>other.roleAssignment.update({where:{id:f.financialGrant.id},data:{validTo:new Date()}}));await plan.recheck();
    })).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("evaluates configured employee review thresholds against the complete run instead of separately smaller jobs",async()=>{
    const f=await claimFixture(),taskId=await fixtures.completeTask(f),run=await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID(),jobs:[...f.input.jobs,{taskId,assignmentId:f.contract.id,confirmedAssignment:true}]},{db});
    await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.approval_thresholds",scopeType:"organization",effectiveFrom:new Date("2020-01-02"),reason:"Explicit whole-run employee cost approval threshold",
      value:{thresholds:[{key:"whole_employee_cost",amount:"750.00",currency:"MAD",requires_approval_from:["finance"]}],routing:{finance:{people:[f.person.id],roles:[],assigned:false,channels:["in_app"]}}}}));
    const input={...f.claimInput,runId:run.id,costs:run.lines.map(line=>({...f.claimInput.costs[0],runLineId:line.id}))};
    const plan=await withTenant(db,f.org,tx=>prepareEmployeeCompensationClaimPolicy(f.claimActor,input,tx));
    expect(plan.total.amount).toBe("1000.50");expect(plan.stages).toHaveLength(2);
    expect(plan.stages.every(stage=>stage.kind==="finance"&&stage.amount==="500.25"&&stage.recipients.length===1&&stage.recipients[0]===f.account.id)).toBe(true);
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("routes configured owner cost review by actual ownership scope without granting access to employee salaries",async()=>{
    const f=await claimFixture();
    const source=await withTenant(db,f.org,async tx=>{
      await tx.propertyOwner.updateMany({where:{organizationId:f.org,propertyId:f.property.id},data:{shareBps:5000}});
      const second=await tx.owner.create({data:{organizationId:f.org,displayName:"Other actual employee work cost owner"}});
      await tx.propertyOwner.create({data:{organizationId:f.org,propertyId:f.property.id,ownerId:second.id,shareBps:5000,isPrimary:false}});
      const reviewers=[];for(const owner of[f.costOwner,second]){
        const person=await tx.person.create({data:{organizationId:f.org,displayName:"Actual scoped cost reviewer"}}),account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id,status:"ACTIVE"}});reviewers.push({owner,person,account});
      }return reviewers;
    });
    for(const reviewer of source){const actor=await fixtures.reader({...f,person:reviewer.person,account:reviewer.account},{scopeType:"owner",scopeId:reviewer.owner.id,permissions:["expense:view","expense:approve","expense:reject"]});expect(actor.ctx.authContext.permissions.has("staff_compensation:view")).toBe(false);}
    await withTenant(db,f.org,async tx=>{
      const rules=new ConfigRuleRepository(tx,f.org);
      await rules.createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-02"),reason:"Actual configured owner funding for completed work",value:{default_treatment:"OWNER_PAID"}});
      await rules.createVersion({key:"finance.approval_thresholds",scopeType:"organization",effectiveFrom:new Date("2020-01-02"),reason:"Explicit independent owner cost review",value:{thresholds:[{key:"actual_owner_cost_review",requires_approval_from:["owner"]}],routing:{owner:{people:source.map(row=>row.person.id),roles:[],assigned:false,channels:["in_app"]}}}});
    });
    const plan=await withTenant(db,f.org,tx=>prepareEmployeeCompensationClaimPolicy(f.claimActor,f.claimInput,tx));
    expect(plan.stages).toHaveLength(2);expect(plan.stages.map(stage=>stage.amount).sort()).toEqual(["250.12","250.13"]);
    for(const stage of plan.stages)expect(stage.recipients).toEqual([source.find(row=>row.owner.id===stage.ownerId)!.account.id]);
    const submitted=await submitEmployeeCompensation(f.claimActor,{...f.claimInput,idempotencyKey:randomUUID(),reason:"Submit the two independently scoped actual owner cost slices"},{db});
    expect(submitted).toMatchObject({state:"PENDING_APPROVAL",claimCount:1,costCount:1});expect(submitted.approvalId).toBeTruthy();
    const actors=await Promise.all(source.map(async reviewer=>({organizationId:f.org,accountId:reviewer.account.id,authContext:await authContextForAccount(f.org,reviewer.account.id,{db})})));
    const stages=await withTenant(db,f.org,tx=>tx.approvalStage.findMany({where:{approvalId:submitted.approvalId!},orderBy:{position:"asc"},include:{recipients:true}}));
    for(const [index,actor]of actors.entries()){
      const visible=await getApproval(actor,submitted.approvalId!,{db});expect(visible.financial?.amount).toBe(stages.find(stage=>stage.ownerId===source[index].owner.id)!.amount.toFixed(2));
      await expect(getEmployeeCompensationSubmission({organizationId:f.org,actorId:actor.accountId,authContext:actor.authContext},{id:submitted.id},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
      expect(visible.history).toHaveLength(1);expect(visible.title).toBe(f.claimInput.costs[0].note);expect(actor.authContext.permissions.has("staff_compensation:view")).toBe(false);
      for(const privateValue of["500.25",f.run.purpose,f.performer.id,source[1-index].owner.id,source[1-index].account.id])expect(JSON.stringify(visible)).not.toContain(privateValue);
      await expect(getApproval(actor,submitted.approvalId!,{db,stageId:stages.find(stage=>stage.ownerId!==source[index].owner.id)!.id})).rejects.toBeInstanceOf(ApprovalAccessError);
    }
    const firstActor=actors.find(actor=>stages[0].recipients.some(recipient=>recipient.userAccountId===actor.accountId))!,lastActor=actors.find(actor=>actor.accountId!==firstActor.accountId)!;
    await expect(decideApproval(lastActor,{id:submitted.approvalId!,stageId:stages[0].id,decision:"APPROVED",reason:"Another owner cannot decide this cost slice"},{db})).rejects.toBeInstanceOf(ApprovalAccessError);
    await expect(decideApproval(lastActor,{id:submitted.approvalId!,stageId:stages[1].id,decision:"APPROVED",reason:"Require the actual configured review sequence"},{db})).rejects.toBeInstanceOf(ApprovalConflictError);
    const decision={id:submitted.approvalId!,stageId:stages[0].id,decision:"APPROVED",reason:"Approve only my original attributed work cost slice"};
    await decideApproval(firstActor,decision,{db});await decideApproval(firstActor,decision,{db});
    expect((await getApproval(lastActor,submitted.approvalId!,{db})).canApprove).toBe(true);
    await decideApproval(lastActor,{...decision,stageId:stages[1].id},{db});
    expect(await withTenant(db,f.org,tx=>tx.approvalRequest.findUniqueOrThrow({where:{id:submitted.approvalId!}}))).toMatchObject({state:"APPROVED"});
    const auditOnly=await fixtures.reader(f,{permissions:["audit_log:view"]}),withoutSalary={...auditOnly.ctx.authContext,permissions:new Set(["audit_log:view"]),assignments:[]};
    const denied=await listAuditHistory({...auditOnly.ctx,authContext:withoutSalary,personId:f.person.id},{resourceType:"employee_compensation_submission"},{db});
    expect(denied.rows.filter(row=>row.resourceId===submitted.id).every(row=>row.after===maskedValue)).toBe(true);
    expect(await facts(f.org)).toMatchObject({journals:0,postings:0});
  });

  it("recovers a real committed creation using only its original actor's nonce and current source authority",async()=>{
    const f=await fixture();expect(await recoverEmployeeCompensationRun(f.ctx,{key:f.input.idempotencyKey},{db})).toEqual({run:null});
    const created=await createEmployeeCompensationRun(f.ctx,f.input,{db}),before=await sourceRows(f.org,created.id);
    expect(await recoverEmployeeCompensationRun(f.ctx,{key:f.input.idempotencyKey},{db})).toMatchObject({run:{id:created.id,total:created.total}});
    const another=await withTenant(db,f.org,async tx=>{const person=await tx.person.create({data:{organizationId:f.org,displayName:"Other recovery reader"}});return{person,account:await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}})};});
    const other=await fixtures.reader({...f,...another},{permissions:["employee_payable:view","employee_payable:create","staff_compensation:view"]});
    await expect(recoverEmployeeCompensationRun(other.ctx,{key:f.input.idempotencyKey},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    const denied={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set<string>()}};
    await expect(recoverEmployeeCompensationRun(denied,{key:f.input.idempotencyKey},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    await expect(recoverEmployeeCompensationRun(denied,{key:randomUUID()},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    expect(await sourceRows(f.org,created.id)).toEqual(before);expect(await facts(f.org)).toMatchObject({runs:1,lines:1,createdAudits:1,cancellations:0,journals:0,postings:0});
  });

  it("offers genuine completed work with every eligible overlapping contract and independent source labels",async()=>{
    const f=await fixture("PROXY",true),editor=await getEmployeeCompensationRunEditor(f.ctx,{db});
    expect(editor).toMatchObject({baseCurrency:"MAD",timezone:"UTC",maxPeriodDays:31});expect(editor.currencies).toContain("MAD");
    const alternate=await assignTeamRole({...f.ctx,personId:f.person.id},{personId:f.performer.id,roleId:f.role.id,scopeType:"organization",scopeId:null,userAccountId:null,
      validFrom:"2020-01-01",validTo:null,assignedToMe:false,reason:"Explicit overlapping contract choice for completed work"},{db});
    await saveTeamCompensation({...f.ctx,personId:f.person.id},{assignmentId:alternate.id,expectedVersion:0,mode:"PER_JOB",amount:"750.00",currency:"MAD",effectiveFrom:"2020-01-01",
      reason:"Canonical alternative organization-wide work contract"},{db});
    const options=await listEmployeeCompensationWork(f.ctx,{fromOn:f.input.fromOn,toOn:f.input.toOn,currency:"MAD"},{db});
    expect(options.items).toHaveLength(1);expect(options.items[0].taskId).toBe(f.taskId);
    expect(new Set(options.items[0].choices.map(row=>row.assignmentId))).toEqual(new Set([f.contract.id,alternate.id]));
    expect(options.items[0].choices.map(row=>row.rate.amount).sort()).toEqual(["500.25","750.00"]);
    for(const choice of options.items[0].choices)expect(choice).toMatchObject({personName:null,propertyName:null,completionMethod:"PROXY",validatorName:"Compensation administrator",contractVersion:1});
    expect(JSON.stringify(options)).not.toMatch(/Performer without login|Contract property|Private address|validation_reason|requestFingerprint|policySnapshot|sourceSnapshot/u);
    const picked=options.items[0].choices.find(row=>row.assignmentId===alternate.id)!;
    const created=await createEmployeeCompensationRun(f.ctx,{...f.input,jobs:[{taskId:f.taskId,assignmentId:picked.assignmentId,confirmedAssignment:true}]},{db});
    expect(created.total).toEqual({amount:"750.00",currency:"MAD"});expect(created.lines[0].assignmentId).toBe(alternate.id);
  });

  it("requires independent real salary access before resolving private rate configuration for selectable work",async()=>{
    const f=await fixture(),denied={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set([...f.ctx.authContext.permissions].filter(key=>key!=="staff_compensation:view"))}};
    const spy=vi.spyOn(ConfigRuleRepository.prototype,"resolveDatedScopeGroups");
    try{expect((await listEmployeeCompensationWork(denied,{fromOn:f.input.fromOn,toOn:f.input.toOn,currency:"MAD"},{db})).items).toEqual([]);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
    const capped={...f.ctx,authContext:{...f.ctx.authContext,assignments:f.ctx.authContext.assignments!.map(assignment=>assignment.permissions.has("staff_compensation:view")?{...assignment,conditions:{maxAmount:"400.00"}}:assignment)}};
    expect((await listEmployeeCompensationWork(capped,{fromOn:f.input.fromOn,toOn:f.input.toOn,currency:"MAD"},{db})).items).toEqual([]);
    expect(await facts(f.org)).toMatchObject({runs:0,lines:0,journals:0,postings:0});
  });

  it("paginates actual completed work with original PostgreSQL microseconds and binds the cursor to actor and earning filters",async()=>{
    const f=await fixture(),ids=[f.taskId];for(let index=0;index<27;index++)ids.push(await fixtures.completeTask(f));
    const input={fromOn:f.input.fromOn,toOn:f.input.toOn,currency:"MAD"},first=await listEmployeeCompensationWork(f.ctx,input,{db});
    expect(first.items).toHaveLength(25);expect(first.next).toBeTruthy();
    const cursor=z.object({at:z.string(),id:z.string()}).passthrough().parse(JSON.parse(decryptSecret(first.next!)));expect(cursor.at).toMatch(/\.\d{6}Z$/u);
    const actual=await withTenant(db,f.org,tx=>tx.$queryRaw<Array<{at:string}>>`SELECT to_char(completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at FROM operation_task WHERE organization_id=${f.org}::uuid AND id=${cursor.id}::uuid`);
    expect(cursor.at).toBe(actual[0].at);
    const second=await listEmployeeCompensationWork(f.ctx,{...input,after:first.next},{db});expect(second.items).toHaveLength(3);expect(second.next).toBeNull();
    expect(new Set([...first.items,...second.items].map(row=>row.taskId))).toEqual(new Set(ids));
    await expect(listEmployeeCompensationWork(f.ctx,{...input,currency:"EUR",after:first.next},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    const other=await fixture();await expect(listEmployeeCompensationWork(other.ctx,{...input,after:first.next},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
  });

  it("denies a late source grant change after selectable labels and rate rules have been loaded",async()=>{
    const f=await fixture(),original=Object.getOwnPropertyDescriptor(EmployeeCompensationPickerRepository.prototype,"display")!.value as EmployeeCompensationPickerRepository["display"];
    const spy=vi.spyOn(EmployeeCompensationPickerRepository.prototype,"display").mockImplementation(async function(this:EmployeeCompensationPickerRepository,entries:Parameters<EmployeeCompensationPickerRepository["display"]>[0]){
      const rows=await original.call(this,entries);await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.runGrant.id},data:{validTo:new Date()}}));return rows;
    });
    try{await expect(listEmployeeCompensationWork(f.ctx,{fromOn:f.input.fromOn,toOn:f.input.toOn,currency:"MAD"},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);}finally{spy.mockRestore();}
    expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.employee_compensation_work.listed"}}))).toBe(0);
  });

  it("protects source names independently while retaining actual completed-work and contract evidence",async()=>{
    const f=await fixture("PROXY",true),created=await createEmployeeCompensationRun(f.ctx,f.input,{db});
    const hidden=await getEmployeeCompensationRunDetail(f.ctx,{id:created.id},{db});
    expect(hidden.labels).toEqual([expect.objectContaining({personName:null,propertyName:null,validatorName:"Compensation administrator",roleName:"Contracted pool work",contractVersion:1,
      completionMethod:"PROXY",sourceTitle:{en:"Perform contracted work",fr:"Réaliser le travail contractuel"},canViewTask:true})]);
    expect(JSON.stringify(hidden)).not.toMatch(/Performer without login|Contract property|Private address|validation_reason|sourceSnapshot|policySnapshot/u);
    const identity=await fixtures.reader(f,{permissions:["identity:view","property:view"],scopeType:"property",scopeId:f.property.id});
    const visible=await getEmployeeCompensationRunDetail(identity.ctx,{id:created.id},{db});
    expect(visible.labels[0]).toMatchObject({personName:"Performer without login",propertyName:"Contract property",validatorName:"Compensation administrator"});
    expect(visible.lines).toEqual(hidden.lines);expect(visible.total).toEqual(hidden.total);
    const operationallyRestricted={...identity.ctx,authContext:{...identity.ctx.authContext,permissions:new Set([...identity.ctx.authContext.permissions].filter(key=>key!=="task:view"))}};
    expect((await getEmployeeCompensationRunDetail(operationallyRestricted,{id:created.id},{db})).labels[0]).toMatchObject({sourceTitle:null,canViewTask:false,personName:"Performer without login"});
  });

  it("allows an actual performer to see their own name without granting unrelated identity or property details",async()=>{
    const f=await fixture(),created=await createEmployeeCompensationRun(f.ctx,f.input,{db});
    const worker=await fixtures.reader({...f,person:f.staff,account:f.staffAccount},{permissions:["employee_payable:view","staff_compensation:view"]});
    const detail=await getEmployeeCompensationRunDetail(worker.ctx,{id:created.id},{db});
    expect(detail.labels[0]).toMatchObject({personName:"Private staff member",propertyName:null,validatorName:null});expect(detail.canCancel).toBe(false);
  });

  it("rechecks independent identity authority immediately before returning source labels",async()=>{
    const f=await fixture(),created=await createEmployeeCompensationRun(f.ctx,f.input,{db}),grant=await fixtures.reader(f,{permissions:["identity:view","property:view"]});
    const before=await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.employee_compensation_run.viewed"}}));
    const original=Object.getOwnPropertyDescriptor(EmployeeCompensationRunRepository.prototype,"find")!.value as EmployeeCompensationRunRepository["find"];let reads=0;
    const spy=vi.spyOn(EmployeeCompensationRunRepository.prototype,"find").mockImplementation(async function(this:EmployeeCompensationRunRepository,id:string){
      const result=await original.call(this,id);if(++reads===3)await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:grant.grant.id},data:{validTo:new Date()}}));return result;
    });
    try{await expect(getEmployeeCompensationRunDetail(grant.ctx,{id:created.id},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);}finally{spy.mockRestore();}
    expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.employee_compensation_run.viewed"}}))).toBe(before);
  });

  it("lists only independently authorized run totals and beneficiary aggregates with encrypted actor-bound cursors",async()=>{
    const f=await fixture();
    const created=[];for(let index=0;index<12;index++)created.push(await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID(),purpose:"Saved completed work run "+index},{db}));
    const first=await listEmployeeCompensationRuns(f.ctx,{query:"Saved completed",state:"draft"},{db});
    expect(first.runs).toHaveLength(10);expect(first.next).toBeTruthy();expect(first.canCreate).toBe(true);
    expect(first.next).not.toContain(created[0].id);expect(JSON.stringify(first)).not.toMatch(/Private staff|Contract property|idempotencyKey|sourceSnapshot|requestFingerprint/u);
    const second=await listEmployeeCompensationRuns(f.ctx,{query:"Saved completed",state:"draft",after:first.next},{db});expect(second.runs).toHaveLength(2);expect(second.next).toBeNull();
    expect(new Set([...first.runs,...second.runs].map(row=>row.id)).size).toBe(12);
    await expect(listEmployeeCompensationRuns(f.ctx,{query:"Changed filter",state:"draft",after:first.next},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    const foreign=await fixture();await expect(listEmployeeCompensationRuns(foreign.ctx,{query:"Saved completed",state:"draft",after:first.next},{db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);
    const extra=await fixtures.completeTask(f),large=await createEmployeeCompensationRun(f.ctx,{...f.input,idempotencyKey:randomUUID(),purpose:"Aggregate salary visibility cap",
      jobs:[...f.input.jobs,{taskId:extra,assignmentId:f.contract.id,confirmedAssignment:true}]},{db});
    const capped={...f.ctx,authContext:{...f.ctx.authContext,assignments:f.ctx.authContext.assignments!.map(assignment=>assignment.permissions.has("staff_compensation:view")?{...assignment,conditions:{maxAmount:"750.00"}}:assignment)}};
    expect((await listEmployeeCompensationRuns(capped,{query:"Aggregate salary"},{db})).runs).toEqual([]);
    await cancelEmployeeCompensationRun(f.ctx,{id:large.id,reason:"Retain original completed work during list filtering"},{db});
    expect((await listEmployeeCompensationRuns(f.ctx,{state:"cancelled"},{db})).runs.map(row=>row.id)).toEqual([large.id]);
    const denied={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set<string>()}};
    expect(await listEmployeeCompensationRuns(denied,{}, {db})).toMatchObject({runs:[],next:null,canCreate:false});
  });

  it("rolls back the list receipt when run authority expires after loading actual sources",async()=>{
    const f=await fixture(),created=await createEmployeeCompensationRun(f.ctx,f.input,{db});
    const before=await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.employee_compensation_run.listed"}}));
    const original=Object.getOwnPropertyDescriptor(EmployeeCompensationRunRepository.prototype,"findMany")!.value as EmployeeCompensationRunRepository["findMany"];
    const spy=vi.spyOn(EmployeeCompensationRunRepository.prototype,"findMany").mockImplementation(async function(this:EmployeeCompensationRunRepository,ids:readonly string[]){
      const rows=await original.call(this,ids);expect(ids).toContain(created.id);await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.runGrant.id},data:{validTo:new Date()}}));return rows;
    });
    try{await expect(listEmployeeCompensationRuns(f.ctx,{}, {db})).rejects.toBeInstanceOf(EmployeeCompensationRunAccessError);}finally{spy.mockRestore();}
    expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.employee_compensation_run.listed"}}))).toBe(before);
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
      await fixtures.reader(f,{permissions:["employee_payable:edit"]});
      const costActor=await fixtures.reader(f,{permissions:["financial_transaction:view","expense:view","expense:approve","expense:reject"]});
      await withTenant(db,f.org,async tx=>{
        const owner=await tx.owner.create({data:{organizationId:f.org,displayName:"Actual portfolio work cost owner"}});
        await tx.propertyOwner.createMany({data:[f.property,...properties].map(property=>({organizationId:f.org,propertyId:property.id,ownerId:owner.id}))});
        const rules=new ConfigRuleRepository(tx,f.org);
        await rules.createVersion({key:"finance.expense_treatment",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{default_treatment:"ALVILLAS_PAID"},reason:"Explicit portfolio completed-work cost allocation"});
        await rules.createVersion({key:"finance.approval_thresholds",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{thresholds:[]},reason:"Explicit portfolio completed-work review policy"});
      });
      const portfolio=await withTenant(db,f.org,tx=>new EmployeeCompensationRunRepository(tx,f.org).find(many.result.id));expect(portfolio).toBeTruthy();
      queryCount=0;const costStarted=performance.now();
      const costs=await withTenant(measured,f.org,tx=>prepareEmployeeCompensationClaimPolicy(costActor.ctx,{runId:many.result.id,costOn:f.input.fromOn,emergency:false,
        costs:portfolio!.lines.map(line=>({runLineId:line.id,category:"staff",costCenter:null,note:"Review actual completed work across the property portfolio"}))},tx),{timeout:120000});
      expect(costs.total.amount).toBe("250125.00");expect(costs.costs).toHaveLength(500);
      const costMeasurement={actualCompletedProperties:500,actualSourceCosts:costs.costs.length,queries:queryCount,durationMs:Math.round(performance.now()-costStarted),noFinancialMovements:true};
      if(process.env.AUT_RECORD_RUN_CAPACITY==="1")writeFileSync(".tmp/employee-claim-policy-capacity-500.json",JSON.stringify(costMeasurement,null,2),{flag:"wx"});
      console.info(JSON.stringify(costMeasurement));
      const command={runId:many.result.id,costOn:f.input.fromOn,emergency:false,idempotencyKey:randomUUID(),reason:"Submit the complete actual portfolio work through durable execution",
        costs:portfolio!.lines.map(line=>({runLineId:line.id,category:"staff",costCenter:null,note:"Review actual completed work across the property portfolio"}))};
      const requestStarted=performance.now(),queued=await requestEmployeeCompensationSubmission(costActor.ctx,command,{db:measured}),requestMs=Math.round(performance.now()-requestStarted);expect(queued.state).toBe("PENDING");
      const event=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{type:employeeCompensationSubmissionRequested,payload:{path:["requestId"],equals:queued.requestId}}}));
      const workerStarted=performance.now(),finished=await executeEmployeeCompensationSubmissionReference({organizationId:f.org,outboxEventId:event.id},{db:measured}),workerMs=Math.round(performance.now()-workerStarted);
      expect(finished.state).toBe("SUCCEEDED");expect(finished.submissionId).toBeTruthy();
      const readStarted=performance.now(),submitted=await getEmployeeCompensationSubmission(costActor.ctx,{id:finished.submissionId!},{db}),detailMs=Math.round(performance.now()-readStarted);
      expect(submitted.total.amount).toBe("250125.00");expect(submitted.costCount).toBe(500);expect(submitted.claimCount).toBe(1);expect(submitted.costs).toHaveLength(50);expect(submitted.nextCursor).toBeTruthy();
      const following=await getEmployeeCompensationSubmission(costActor.ctx,{id:finished.submissionId!,after:submitted.nextCursor!},{db});expect(following.costs).toHaveLength(50);expect(new Set([...submitted.costs,...following.costs].map(cost=>cost.id)).size).toBe(100);
      const durableMeasurement={actualCompletedProperties:500,actualSourceCosts:500,requestMs,workerMs,detailMs,actualClaimCount:1,claimedAmount:submitted.total,noFinancialMovements:true};
      if(process.env.AUT_RECORD_EMPLOYEE_CLAIM_CAPACITY==="1")writeFileSync(".tmp/employee-submission-capacity-500.json",JSON.stringify(durableMeasurement,null,2),{flag:"wx"});
      console.info(JSON.stringify(durableMeasurement));
      expect(await facts(f.org)).toMatchObject({runs:2,lines:501,createdAudits:2,outbox:2,journals:0,postings:0});
      const measurement={actualCompletedProperties:500,sourceQueriesOne:one.queries,sourceQueries500:many.queries,singleMs:Math.round(one.durationMs),portfolioMs:Math.round(many.durationMs),noFinancialMovements:true};
      if(process.env.AUT_RECORD_RUN_CAPACITY==="1"){mkdirSync(".tmp",{recursive:true});writeFileSync(".tmp/employee-run-capacity-500.json",JSON.stringify(measurement,null,2),{flag:"wx"});}
      console.info(JSON.stringify(measurement));
    }finally{await measured.$disconnect();}
  });
});
