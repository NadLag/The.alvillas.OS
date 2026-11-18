import { readAssetLifecycle, recordAssetLifecycle } from "@/modules/assets/application/asset-lifecycle";
import { generateRecurringOperations } from "@/modules/reservations/application/operation-automation";
import { readAssetPreventiveSchedule, saveAssetPreventiveSchedule } from "@/modules/assets/application/preventive-schedule";
import { tickAssetWarrantyReminders } from "@/modules/assets/application/warranty-alerts";
import { getAsset, listAssets, saveAsset } from "@/modules/assets/application/asset-service";
import { AssetAccessError, AssetConflictError } from "@/modules/assets/domain/asset";
import { changeWorkOrderAsset, readWorkOrderAssets } from "@/modules/maintenance/application/work-order-assets";
import { maintenanceIssueSourceChoices } from "@/modules/maintenance/application/issue-source-choices";
import { previewMaintenanceIssueLink, publishMaintenanceIssueLink } from "@/modules/maintenance/application/issue-link-service";
import { readMaintenanceIssue } from "@/modules/maintenance/application/issue-read-service";
import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {it,expect,beforeAll,afterAll,afterEach,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {nativeGuestHubFixture} from "./support/guest-hub-fixture";
import {provisionIntegrationRole} from "./support/database-role";
import {reportOperationIssue} from "@/modules/reservations/application/operation-evidence";
import {createOperationTask,transitionOperationTask,proxyCompleteOperationTask} from "@/modules/reservations/application/operation-service";
import {previewWorkOrderRegistration,publishWorkOrderRegistration,recoverWorkOrderRegistration,workOrderRegistrationCommandStatus} from "@/modules/maintenance/application/work-order-registration";
import {readIssueWorkOrders,workOrderTaskChoices} from "@/modules/maintenance/application/work-order-workspace";
import {WorkOrderAccessError,WorkOrderConflictError} from "@/modules/maintenance/domain/work-order";
import {WorkOrderRepository} from "@/modules/maintenance/infrastructure/work-order-repository";
import {listAuditHistory} from "@/modules/audit/application/audit-service";
import {createExpenseDraft,updateExpenseDraft,submitExpense,ExpenseConflictError} from "@/modules/finance/application/expense-service";
import {ExpenseRepository} from "@/modules/finance/infrastructure/expense-repository";
import {createManualReservation,ReservationConflictError} from "@/modules/reservations/application/reservation-service";

import { assignOperationTask } from "@/modules/reservations/application/operation-scheduling";

import operatingPolicy from "@/platform/config/defaults/operations.json";
import { postExpense } from "@/modules/finance/application/expense-posting-service";
import { decideApproval, getApproval } from "@/platform/approvals/approval-service";
import { createSupplier } from "@/modules/finance/application/supplier-service";
import { createSupplierInvoice } from "@/modules/finance/application/supplier-invoice-service";
import { previewWorkOrderFinance, publishWorkOrderFinance, readWorkOrderFinance, searchWorkOrderFinance, workOrderFinanceStatus } from "@/modules/maintenance/application/work-order-finance";
import {previewWorkOrderExpense} from "@/modules/maintenance/application/work-order-expense-preview";

let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{const url=new URL(process.env.TEST_DATABASE_URL!);if(!["127.0.0.1","localhost"].includes(url.hostname)||!(url.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&url.pathname==="/alvillas_os"))throw Error("Owned maintenance work-order database required");admin=new PrismaClient({datasourceUrl:url.toString()});await provisionIntegrationRole(admin,"alvillas_ops_tests");url.username=url.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:url.toString()});});
afterEach(()=>vi.restoreAllMocks());afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
async function fixture(extraKeys:string[]=[], propertyOnly=false){
 const f=await nativeGuestHubFixture(admin,db),grants:Record<string,string>={},deps={db,requestId:randomUUID(),ipAddress:null};
 await withTenant(db,f.organizationId,async tx=>{
  for(const key of new Set(["task:view","task:edit","issue:view","issue:create","issue:edit","property:view","audit_log:view",...extraKeys])){const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key}}),role=await tx.role.create({data:{organizationId:f.organizationId,key:"maintenance_order_"+randomUUID(),name:"Original maintenance order "+key}});await tx.rolePermission.create({data:{organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}});grants[key]=(await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}})).id;}
  await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"ops.checklists",scopeType:"property",scopeId:f.property.id,createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),reason:"Actual original maintenance checklist configuration",value:{checklists:[{key:"maintenance_original",name:{en:"Maintenance",fr:"Maintenance",ar:"الصيانة"},items:[{key:"original_evidence",label:{en:"Retain original evidence",fr:"Conserver les preuves originales",ar:"حفظ الأدلة الأصلية"}}]}]}});
 });
 const actor={...f.ctx,authContext:{...await authContextForAccount(f.organizationId,f.account.id,{db}),personId:f.person.id}},sourceTask=await withTenant(db,f.organizationId,tx=>tx.operationTask.findFirstOrThrow({where:{organizationId:f.organizationId,reservationId:f.reservation.id}})),issueId=await reportOperationIssue(actor,{taskId:sourceTask.id,title:"Original repair observation",description:"Actual original issue retained before a native maintenance work order",severity:"HIGH",idempotencyKey:randomUUID()},deps),task=await createOperationTask(actor,{propertyId:f.property.id,reservationId:propertyOnly?undefined:f.reservation.id,type:"MAINTENANCE",title:{en:"Original repair work",fr:"Travaux de réparation",ar:"أعمال الإصلاح"},dueDate:"2031-05-02",priority:"HIGH",checklistTemplateKey:"maintenance_original",idempotencyKey:randomUUID(),reason:"Create through the existing canonical maintenance task writer"},deps);
 return{...f,actor,task,sourceTask,issueId,grants,deps,intent:{issueId,taskId:task.id,reason:"Register the original maintenance task for this independently authorized issue"}};
}
async function originals(f:Awaited<ReturnType<typeof fixture>>){return withTenant(db,f.organizationId,async tx=>({tasks:await tx.operationTask.findMany({where:{organizationId:f.organizationId},orderBy:{id:"asc"}}),issues:await tx.operationIssue.findMany({where:{organizationId:f.organizationId},orderBy:{id:"asc"}}),money:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),stock:await tx.inventoryMovement.count({where:{organizationId:f.organizationId}})}));}

it("registers the native maintenance task once with original issue ancestry, immutable audit/receipt, recovery and negative closure",async()=>{
 const f=await fixture(),before=await originals(f),review=await previewWorkOrderRegistration(f.actor,f.intent,f.deps),nonce=randomUUID(),command={intent:review.intent,reviewFingerprint:review.reviewFingerprint,idempotencyKey:nonce};expect(review.task).toMatchObject({id:f.task.id,type:"MAINTENANCE",priority:"HIGH",state:"PLANNED"});expect((await workOrderTaskChoices(f.actor,{issueId:f.issueId},f.deps)).items.map(row=>row.id)).toEqual([f.task.id]);
 const receipts=await Promise.all([publishWorkOrderRegistration(f.actor,command,f.deps),publishWorkOrderRegistration(f.actor,command,f.deps)]);expect(receipts.map(row=>row.taskId)).toEqual([f.task.id,f.task.id]);expect(receipts.map(row=>row.replayed).sort()).toEqual([false,true]);expect(await originals(f)).toEqual(before);
 expect(await readIssueWorkOrders(f.actor,{issueId:f.issueId},f.deps)).toMatchObject({items:[{state:"VISIBLE",task:{id:f.task.id}}]});expect((await workOrderTaskChoices(f.actor,{issueId:f.issueId},f.deps)).items).toEqual([]);
 expect(await recoverWorkOrderRegistration(f.actor,{issueId:f.issueId,taskId:f.task.id,idempotencyKey:nonce},f.deps)).toMatchObject({recorded:true,receipt:{taskId:f.task.id,intent:{issueId:f.issueId}}});
 await expect(withTenant(db,f.organizationId,tx=>tx.$executeRawUnsafe("UPDATE maintenance_work_order SET issue_id=$1::uuid WHERE organization_id=$2::uuid AND id=$3::uuid",randomUUID(),f.organizationId,f.task.id))).rejects.toThrow(/ledger rows are append-only/);
 const audit=await listAuditHistory(f.actor,{resourceType:"maintenance_work_order",resourceId:f.task.id},f.deps);expect(audit.rows).toHaveLength(1);expect(JSON.stringify(audit.rows)).not.toContain(f.intent.reason);
 const closed=randomUUID();expect(await recoverWorkOrderRegistration(f.actor,{issueId:f.issueId,taskId:f.task.id,idempotencyKey:closed},f.deps)).toEqual({recorded:false,receipt:null});await expect(publishWorkOrderRegistration(f.actor,{...command,idempotencyKey:closed},f.deps)).rejects.toBeInstanceOf(WorkOrderConflictError);
 await expect(previewWorkOrderRegistration(f.actor,f.intent,f.deps)).rejects.toBeInstanceOf(WorkOrderConflictError);
 // Later operational progress changes the native task, never the original receipt.
 await transitionOperationTask(f.actor,{taskId:f.task.id,expectedVersion:f.task.version,state:"BLOCKED",reason:"Native maintenance progress remains in the canonical operations lifecycle",idempotencyKey:randomUUID()},f.deps);
 expect(await publishWorkOrderRegistration(f.actor,command,f.deps)).toEqual({...receipts[0],replayed:true});
 const unknown=randomUUID();expect(await workOrderRegistrationCommandStatus(f.actor,{issueId:f.issueId,idempotencyKey:unknown},f.deps)).toMatchObject({state:"UNKNOWN"});expect(await recoverWorkOrderRegistration(f.actor,{issueId:f.issueId,idempotencyKey:unknown},f.deps)).toEqual({recorded:false,receipt:null});expect(await workOrderRegistrationCommandStatus(f.actor,{issueId:f.issueId,idempotencyKey:unknown},f.deps)).toMatchObject({state:"CANCELLED"});
 // Preserve original issue viewing through a narrower job grant, withdrawing
 // access to the independently protected maintenance task.
 await withTenant(db,f.organizationId,async tx=>{const original=await tx.roleAssignment.findUniqueOrThrow({where:{id:f.grants["task:view"]}});await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:f.account.id,personId:f.person.id,roleId:original.roleId,scopeType:"job",scopeId:f.sourceTask.id,validFrom:new Date("2020-01-01")}});await tx.roleAssignment.update({where:{id:original.id},data:{archivedAt:new Date()}});});
 const masked=await readIssueWorkOrders(f.actor,{issueId:f.issueId},f.deps);expect(masked.items).toEqual([{state:"MASKED"}]);expect(JSON.stringify(masked)).not.toContain(f.task.id);await expect(recoverWorkOrderRegistration(f.actor,{issueId:f.issueId,idempotencyKey:nonce},f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);const status=await workOrderRegistrationCommandStatus(f.actor,{issueId:f.issueId,idempotencyKey:nonce},f.deps);expect(status.state).toBe("RECORDED");expect(JSON.stringify(status)).not.toContain(f.task.id);
});
it("rejects foreign tenants, non-maintenance tasks, narrowed authority and stale original task reviews",async()=>{
 const f=await fixture(),other=await fixture();await expect(previewWorkOrderRegistration(f.actor,other.intent,f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);await expect(previewWorkOrderRegistration(f.actor,{...f.intent,taskId:f.sourceTask.id},f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);
 const narrowed={...f.actor,authContext:{...f.actor.authContext,permissions:new Set<string>(),scopes:[],assignments:[]}};await expect(previewWorkOrderRegistration(narrowed,f.intent,f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);
 const review=await previewWorkOrderRegistration(f.actor,f.intent,f.deps);await transitionOperationTask(f.actor,{taskId:f.task.id,expectedVersion:f.task.version,state:"BLOCKED",reason:"An actual native task revision invalidates the old registration review",idempotencyKey:randomUUID()},f.deps);
 await expect(publishWorkOrderRegistration(f.actor,{intent:review.intent,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps)).rejects.toBeInstanceOf(WorkOrderConflictError);expect(await withTenant(db,f.organizationId,tx=>new WorkOrderRepository(tx,f.organizationId).original(f.task.id))).toBeNull();
});
it("requires atomic original audit/receipt and rolls back registration when task editing is withdrawn after insertion",async()=>{
 const f=await fixture(),review=await previewWorkOrderRegistration(f.actor,f.intent,f.deps),before=await originals(f);
 await expect(withTenant(db,f.organizationId,async tx=>{const repository=new WorkOrderRepository(tx,f.organizationId),fingerprint=await repository.nativeFingerprint(f.issueId,f.task.id);if(!fingerprint)throw Error("Original task ancestry required");await repository.insert({schemaVersion:1,organizationId:f.organizationId,actorId:f.actor.actorId,taskId:f.task.id,propertyId:f.property.id,intent:f.intent,idempotencyKey:randomUUID(),nativeFingerprint:fingerprint,sourceFingerprint:"a".repeat(64),reviewFingerprint:review.reviewFingerprint,requestHash:"b".repeat(64),createdAt:(await repository.clock()).toISOString()});})).rejects.toThrow(/original_audit_receipt_required/);
 const nonce=randomUUID(),original=Reflect.get<typeof WorkOrderRepository.prototype,"insert">(WorkOrderRepository.prototype,"insert");vi.spyOn(WorkOrderRepository.prototype,"insert").mockImplementation(async function(this:WorkOrderRepository,value){await original.call(this,value);await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["task:edit"]},data:{archivedAt:new Date()}}));});
 await expect(publishWorkOrderRegistration(f.actor,{intent:review.intent,reviewFingerprint:review.reviewFingerprint,idempotencyKey:nonce},f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);vi.restoreAllMocks();
 expect(await originals(f)).toEqual(before);expect(await withTenant(db,f.organizationId,tx=>new WorkOrderRepository(tx,f.organizationId).original(f.task.id))).toBeNull();expect(await withTenant(db,f.organizationId,tx=>tx.outboxEvent.count({where:{organizationId:f.organizationId,idempotencyKey:"maintenance-work-order:"+f.actor.actorId+":"+nonce}}))).toBe(0);
});
it("reviews exact native expense facts with independent financial authority, reservation ancestry and final source rechecks without posting a cost",async()=>{
 const keys=["expense:create","expense:view","expense:edit","financial_transaction:view"],f=await fixture(keys),other=await fixture(keys),review=await previewWorkOrderRegistration(f.actor,f.intent,f.deps);await publishWorkOrderRegistration(f.actor,{intent:review.intent,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID()},f.deps);
 async function expenseFor(owner:typeof f,reservationId=owner.reservation.id){const funding=await withTenant(db,owner.organizationId,tx=>tx.ledgerAccount.create({data:{organizationId:owner.organizationId,code:"WORK_ORDER_BANK_"+randomUUID().replaceAll("-","").toUpperCase(),name:"Owned original work-order source bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}})),input={propertyId:owner.property.id,reservationId,amount:"0.07",currency:"MAD",category:"maintenance",purpose:"Original native repair cost",occurredOn:new Date().toISOString().slice(0,10),fundingAccountId:funding.id,emergency:false,idempotencyKey:randomUUID(),reason:"Use the original expense writer before linking maintenance cost evidence"},expense=await createExpenseDraft(owner.actor,input,owner.deps);return{input,expense};}
 const native=await expenseFor(f),foreign=await expenseFor(other),secondBooking=await createManualReservation(f.actor,{propertyId:f.property.id,source:"DIRECT",guestName:"Separate original maintenance booking",guestEmail:"maintenance-other-"+randomUUID()+"@example.test",guestPreferredLocale:"en",checkIn:"2032-05-01",checkOut:"2032-05-04",adultCount:1,childCount:0,idempotencyKey:randomUUID()},f.deps),differentBooking=await expenseFor(f,secondBooking.reservation.id),input={taskId:f.task.id,expenseId:native.expense.id};
 const financialSources=()=>withTenant(db,f.organizationId,async tx=>({expenses:await tx.expense.findMany({where:{organizationId:f.organizationId},orderBy:{id:"asc"}}),money:await tx.financialTransaction.count({where:{organizationId:f.organizationId}}),postings:await tx.posting.count({where:{organizationId:f.organizationId}})})),before=await financialSources(),result=await previewWorkOrderExpense(f.actor,input,f.deps);expect(result.expense).toMatchObject({id:native.expense.id,state:"DRAFT",money:{amount:"0.07",currency:"MAD"},reservationId:f.reservation.id,canEdit:true,canSubmit:true});expect(result.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
 await expect(previewWorkOrderExpense(f.actor,{taskId:f.task.id,expenseId:foreign.expense.id},f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);await expect(previewWorkOrderExpense(f.actor,{taskId:f.task.id,expenseId:differentBooking.expense.id},f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);
 const narrow={...f.actor,authContext:{...f.actor.authContext,permissions:new Set([...f.actor.authContext.permissions].filter(key=>key!=="expense:view")),assignments:f.actor.authContext.assignments?.map(grant=>({...grant,permissions:new Set([...grant.permissions].filter(key=>key!=="expense:view"))}))}};await expect(previewWorkOrderExpense(narrow,input,f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);expect(await financialSources()).toEqual(before);
 const original=Reflect.get<typeof ExpenseRepository.prototype,"find">(ExpenseRepository.prototype,"find");let changed=false;vi.spyOn(ExpenseRepository.prototype,"find").mockImplementation(async function(this:ExpenseRepository,id){const value=await original.call(this,id);if(!changed&&id===native.expense.id){changed=true;await updateExpenseDraft(f.actor,{id,expectedVersion:1,draft:{...native.input,amount:"0.09",reason:"A genuine native estimate revision invalidates the old work-order source review"}},f.deps);}return value;});await expect(previewWorkOrderExpense(f.actor,input,f.deps)).rejects.toBeInstanceOf(WorkOrderConflictError);vi.restoreAllMocks();
 expect((await previewWorkOrderExpense(f.actor,input,f.deps)).expense.money).toEqual({amount:"0.09",currency:"MAD"});const revised=await financialSources();let reads=0;vi.spyOn(ExpenseRepository.prototype,"find").mockImplementation(async function(this:ExpenseRepository,id){const value=await original.call(this,id);if(id===native.expense.id&&++reads===2)await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.grants["expense:view"]},data:{archivedAt:new Date()}}));return value;});await expect(previewWorkOrderExpense(f.actor,input,f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);vi.restoreAllMocks();expect(await financialSources()).toEqual(revised);expect((await readIssueWorkOrders(f.actor,{issueId:f.issueId},f.deps)).items).toMatchObject([{state:"VISIBLE",task:{id:f.task.id}}]);
});

it("runs native estimate approval, task completion and expense posting with immutable revisions and invoice evidence", async () => {
  const f = await fixture(["task:assign", "task:validate", "expense:create", "expense:view", "expense:edit", "expense:approve", "expense:reject", "expense:pay", "financial_transaction:view", "financial_transaction:create", "supplier:view", "supplier:create", "supplier_invoice:view", "supplier_invoice:create"], true);
  const registration = await previewWorkOrderRegistration(f.actor, f.intent, f.deps);
  await publishWorkOrderRegistration(f.actor, { intent: f.intent, reviewFingerprint: registration.reviewFingerprint, idempotencyKey: randomUUID() }, f.deps);
  const { funding, performer } = await withTenant(db, f.organizationId, async tx => {
    const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: "Work-order cost owner" } });
    await tx.propertyOwner.create({ data: { organizationId: f.organizationId, propertyId: f.property.id, ownerId: owner.id } });
    const rules = new ConfigRuleRepository(tx, f.organizationId);
    await rules.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-01"), reason: "Use the original configuration for repair cost allocations",
      value: { default_treatment: "CUSTOM", categories: { maintenance: { treatment: "CUSTOM", owner_share_bps: 6000, alvillas_share_bps: 4000, guest_share_bps: 0 } } } });
    await rules.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-01"), reason: "Explicit policy for local work-order estimate acceptance", value: {
        thresholds: [{ key: "higher_repairs", amount: "120.00", currency: "MAD", requires_approval_from: ["finance"] }],
        routing: { finance: { people: [f.person.id], roles: [], assigned: false, channels: ["in_app"] } }
      } });
    const performer = await tx.person.create({ data: { organizationId: f.organizationId, displayName: "Original work-order technician" } });
    const crewRole = await tx.role.create({ data: { organizationId: f.organizationId, key: "dedicated_mnt_technician", name: "Repair technician" } });
    const crewPermissions = await tx.permission.findMany({ where: {
      organizationId: f.organizationId, key: { in: ["task:view", "task:edit"] }
    } });
    await tx.rolePermission.createMany({ data: crewPermissions.map(permission => ({
      organizationId: f.organizationId, roleId: crewRole.id, permissionId: permission.id
    })) });
    await tx.roleAssignment.create({ data: { organizationId: f.organizationId, personId: performer.id, roleId: crewRole.id,
      scopeType: "property", scopeId: f.property.id, validFrom: new Date("2020-01-01") } });
    const operations = structuredClone(operatingPolicy);
    operations.types.MAINTENANCE.role_keys = [crewRole.key];
    await rules.createVersion({ key: "ops.task_policy", scopeType: "property", scopeId: f.property.id,
      effectiveFrom: new Date("2020-01-01"), reason: "Use the actual Operations technician assignment rules", value: operations });
    const funding = await tx.ledgerAccount.create({ data: { organizationId: f.organizationId, code: "WORK_ORDER_COST_BANK",
      name: "Original work-order costs funding location", accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
    return { funding, performer };
  });
  const taskId = f.task.id;
  const intent = { kind: "estimate", taskId, reason: "Record the contractor's original quote",
    expectedRevision: 0, fields: { amount: "100.01", currency: "MAD", purpose: "Repair equipment including labor", category: "maintenance", occurredOn: "2026-11-18" } };
  const review = await previewWorkOrderFinance(f.actor, intent, f.deps);
  expect(review.detail).toMatchObject({ kind: "estimate", revision: 1, allocation: { owner: { amount: "60.01" }, alvillas: { amount: "40.00" }, guest: { amount: "0.00" } } });
  const command = { intent, fingerprint: review.fingerprint, idempotencyKey: randomUUID() };
  await expect(Promise.all([publishWorkOrderFinance(f.actor, command, f.deps), publishWorkOrderFinance(f.actor, command, f.deps)]))
    .resolves.toEqual([{ recorded: true }, { recorded: true }]);
  await expect(workOrderFinanceStatus(f.actor, { taskId, idempotencyKey: command.idempotencyKey }, f.deps)).resolves.toEqual({ recorded: true });
  await expect(publishWorkOrderFinance(f.actor, { ...command, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(WorkOrderConflictError);
  const revision = { ...intent, expectedRevision: 1, fields: { ...intent.fields, amount: "126.10" } };
  const revised = await previewWorkOrderFinance(f.actor, revision, f.deps);
  await publishWorkOrderFinance(f.actor, { intent: revision, fingerprint: revised.fingerprint, idempotencyKey: randomUUID() }, f.deps);
  const expense = await createExpenseDraft(f.actor, { propertyId: f.property.id, amount: "25.10", currency: "MAD",
    occurredOn: new Date().toISOString().slice(0, 10), category: "maintenance", purpose: "Native repair expense", emergency: false,
    fundingAccountId: funding.id, idempotencyKey: randomUUID(), reason: "Record the original work-order expense" }, f.deps);
  const supplier = await createSupplier(f.actor, { idempotencyKey: randomUUID(), displayName: "Work-order contractor",
    category: "Maintenance", reason: "Record the native maintenance contractor" }, f.deps);
  const invoice = await createSupplierInvoice(f.actor, { supplierId: supplier.id, invoiceNumber: "MNT-TEST-COST",
    currency: "MAD", purpose: "Native repair invoice", issuedOn: "2026-11-18",
    lines: [{ propertyId: f.property.id, amount: "100.00", category: "maintenance" }],
    reason: "Record the separate native repair invoice", idempotencyKey: randomUUID() }, f.deps);
  expect((await searchWorkOrderFinance(f.actor, { taskId, kind: "invoice", query: "MNT-TEST" }, f.deps)).items.map(item => item.id)).toEqual([invoice.id]);
  for (const [kind, sourceId] of [["expense", expense.id], ["invoice", invoice.id]]) {
    const link = { kind, sourceId, taskId, reason: "Associate the original financial record with this repair" };
    const reviewed = await previewWorkOrderFinance(f.actor, link, f.deps);
    await publishWorkOrderFinance(f.actor, { intent: link, fingerprint: reviewed.fingerprint, idempotencyKey: randomUUID() }, f.deps);
  }
  const pending = await readWorkOrderFinance(f.actor, { taskId }, f.deps);
  const approvalEntry = pending.items.find(row => "detail" in row && row.detail.kind === "estimate" && row.detail.revision === 2);
  if (!approvalEntry || !("detail" in approvalEntry) || approvalEntry.detail.kind !== "estimate" || !approvalEntry.detail.approval)
    throw new Error("Expected the original estimate approval binding");
  expect(approvalEntry.detail.approval.state).toBe("PENDING");
  expect(pending.canEstimate).toBe(false);
  const approvalActor = { organizationId: f.organizationId, accountId: f.actor.actorId, authContext: f.actor.authContext };
  const approval = await getApproval(approvalActor, approvalEntry.detail.approval.id, f.deps);
  expect(approval).toMatchObject({ canApprove: true, financial: { amount: "126.10", currency: "MAD" } });
  const release = await withTenant(db, f.organizationId, async tx => {
    const [row] = await tx.$queryRawUnsafe<Array<{ allowed: boolean }>>(
      "SELECT app_maintenance_estimate_work_allowed($1::uuid,$2::uuid) AS allowed", f.organizationId, taskId);
    return row.allowed;
  });
  expect(release).toBe(false);
  const assigned = await assignOperationTask(f.actor, { taskId, expectedVersion: f.task.version, personId: performer.id, startMinute: 600,
    reason: "Assign the original technician to the canonical work task", idempotencyKey: randomUUID() }, f.deps);
  const start = { taskId, expectedVersion: assigned.version, state: "IN_PROGRESS",
    reason: "Start work according to the latest estimate", idempotencyKey: randomUUID() };
  await expect(transitionOperationTask(f.actor, start, f.deps)).rejects.toBeInstanceOf(ReservationConflictError);
  const submitted = await submitExpense(f.actor, { id: expense.id, expectedVersion: 1, reason: "Submit the actual repair expense" }, f.deps);
  const post = { id: expense.id, expectedVersion: submitted.version, reason: "Post the original actual cost after work completion" };
  await expect(postExpense(f.actor, post, f.deps)).rejects.toBeInstanceOf(ExpenseConflictError);
  expect((await originals(f)).money).toBe(0);
  await decideApproval(approvalActor, { id: approval.id, stageId: approval.stageId,
    decision: "APPROVED", reason: "Responsible finance reviewer accepted the revised repair quote" }, f.deps);
  await expect(getApproval(approvalActor, approval.id, f.deps)).resolves.toMatchObject({ state: "APPROVED" });
  const started = await transitionOperationTask(f.actor, start, f.deps);
  await proxyCompleteOperationTask(f.actor, { taskId, expectedVersion: started.version, performedByPersonId: performer.id,
    checklistItemIds: started.checklistItems.map(item => item.id), idempotencyKey: randomUUID(),
    reason: "Validate the original work with the retained repair checklist" }, f.deps);
  const posted = await postExpense(f.actor, post, f.deps);
  expect(posted.transactionId).toBeTruthy();
  await expect(postExpense(f.actor, post, f.deps)).resolves.toMatchObject({ transactionId: posted.transactionId, idempotent: true });
  const history = await readWorkOrderFinance(f.actor, { taskId }, f.deps);
  expect(history.items.map(row => "detail" in row ? row.detail.kind : "masked")).toEqual(["invoice", "expense", "estimate", "estimate"]);
  expect(history.latestRevision).toBe(2);
  expect(history.canEstimate).toBe(true);
  expect(history.items[2]).toMatchObject({ detail: { approval: { id: approval.id, state: "APPROVED" } } });
  expect((await originals(f)).money).toBe(1);
  expect(history.items[1]).toMatchObject({ detail: { source: { state: "POSTED", money: { amount: "25.10" } } } });
  await expect(withTenant(db, f.organizationId, tx => tx.$executeRawUnsafe(
    "UPDATE maintenance_work_order_finance SET reason = 'changed reason' WHERE task_id = $1::uuid", taskId
  ))).rejects.toThrow(/append-only/u);
  await withTenant(db, f.organizationId, tx => tx.roleAssignment.update({
    where: { id: f.grants["supplier_invoice:view"] }, data: { archivedAt: new Date() }
  }));
  expect((await readWorkOrderFinance(f.actor, { taskId }, f.deps)).items[0]).toEqual({ masked: true });
});

it("registers and links canonical property assets with exact cost, unchanged sources and scoped history", async () => {
  const keys = ["asset:view", "asset:create", "asset:edit", "asset_cost:view", "asset_cost:edit", "asset:void", "task:create"];
  const f = await fixture(keys), external = await fixture(keys);
  const data = {
    tag: "PUMP-0042", propertyId: f.property.id, idempotencyKey: randomUUID(), reason: "Record the original installed pool pump",
    fields: { name: "Installed pool pump", category: "Pool equipment", description: "Original pump near the pool",
      condition: "GOOD", purchaseOn: "2024-02-29", cost: { amount: "9999999999999999.99", currency: "MAD" },
      warrantyProvider: "Original warranty supplier", warrantyReference: "WR-9001", warrantyStartsOn: "2024-02-29",
      warrantyEndsOn: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10), usefulLifeMonths: 120 }
  };
  const asset = await saveAsset(f.actor, data, f.deps);
  const replay = await saveAsset(f.actor, data, f.deps);
  expect(replay).toEqual(asset);
  await expect(saveAsset(f.actor, { ...data, idempotencyKey: randomUUID() }, f.deps)).rejects.toBeInstanceOf(AssetConflictError);
  const foreign = await saveAsset(external.actor, { ...data, tag: "FOREIGN-PUMP", propertyId: external.property.id, idempotencyKey: randomUUID() }, external.deps);
  const successor = await saveAsset(f.actor, { ...data, tag: "PUMP-0043", idempotencyKey: randomUUID(),
    fields: { ...data.fields, warrantyEndsOn: null, warrantyStartsOn: null } }, f.deps);
  expect((await getAsset(f.actor, { assetId: asset.id }, f.deps)).asset.cost).toEqual(data.fields.cost);
  await expect(getAsset(f.actor, { assetId: foreign.id }, f.deps)).rejects.toBeInstanceOf(AssetAccessError);
  expect((await listAssets(f.actor, { query: "PUMP-0042" }, f.deps)).items.map(row => row.id)).toEqual([asset.id]);

  await withTenant(db, f.organizationId, async tx => {
    const rules = new ConfigRuleRepository(tx, f.organizationId);
    const scope = { scopeType: "property", scopeId: f.property.id, createdBy: f.account.id,
      effectiveFrom: new Date("2020-01-01"), reason: "Set warranty renewal alerts for the original pump manager" } as const;
    await rules.createVersion({ ...scope, key: "ops.asset_warranty_alerts", value: { lead_days: [365, 30] } });
    await rules.createVersion({ ...scope, key: "notification.routing.asset_warranty_expiring",
      value: { roles: [], people: [f.person.id], assigned: false, channels: ["in_app"] } });
    await tx.notificationPreference.upsert({
      where: { organizationId_userAccountId: { organizationId: f.organizationId, userAccountId: f.account.id } },
      update: { inAppEnabled: true, inAppOperations: true },
      create: { organizationId: f.organizationId, userAccountId: f.account.id, inAppEnabled: true, inAppOperations: true }
    });
  });
  expect(await tickAssetWarrantyReminders(external.organizationId, db)).toBe(0);
  expect(await tickAssetWarrantyReminders(f.organizationId, db)).toBe(1);
  expect(await tickAssetWarrantyReminders(f.organizationId, db)).toBe(0);
  expect(await withTenant(db, f.organizationId, tx => tx.notification.count({ where: {
    organizationId: f.organizationId, recipientId: f.account.id, kind: "asset_warranty_expiring"
  } }))).toBe(1);


  const now = new Date(), today = now.toISOString().slice(0, 10);
  const schedule = { assetId: asset.id, expectedVersion: 0, cancelFuture: false, reason: "Service the original installed pool pump",
    definition: { title: { en: "Service pool pump", fr: "Entretenir la pompe" },
      starts_on: today, ends_on: null, start_minute: 540, every_days: 1, weekdays: [0, 1, 2, 3, 4, 5, 6],
      checklist_template_key: "maintenance_original", priority: "NORMAL", enabled: true } };
  await saveAssetPreventiveSchedule(f.actor, schedule, f.deps);
  const range = { propertyId: f.property.id, from: today, until: today };
  expect(await generateRecurringOperations(f.actor, range, { ...f.deps, now: new Date(Date.now() + 1000) })).toMatchObject({ created: 1 });
  expect(await generateRecurringOperations(f.actor, range, { ...f.deps, now: new Date(Date.now() + 1000) })).toMatchObject({ created: 0, existing: 1 });
  expect(await readAssetPreventiveSchedule(f.actor, asset.id, db)).toMatchObject({
    version: 1, schedule: { enabled: true }, tasks: [{ state: "PLANNED" }]
  });

  const reviewed = await previewWorkOrderRegistration(f.actor, f.intent, f.deps);
  await publishWorkOrderRegistration(f.actor, { intent: f.intent, reviewFingerprint: reviewed.reviewFingerprint, idempotencyKey: randomUUID() }, f.deps);
  const choices = await maintenanceIssueSourceChoices(f.actor, { issueId: f.issueId, kind: "ASSET", query: "PUMP-0042" }, f.deps);
  expect(choices).toMatchObject({ ready: true, items: [{ reference: { kind: "ASSET", id: asset.id }, navigation: { kind: "ASSET", id: asset.id } }] });
  const issueLink = { issueId: f.issueId, expectedVersion: "0", operation: "ATTACH",
    source: { kind: "ASSET", id: asset.id }, reason: "Link the original damaged pump to the maintenance observation" };
  const linkReview = await previewMaintenanceIssueLink(f.actor, issueLink, f.deps);
  await publishMaintenanceIssueLink(f.actor, { intent: issueLink, reviewFingerprint: linkReview.reviewFingerprint, idempotencyKey: randomUUID() }, f.deps);
  expect((await readMaintenanceIssue(f.actor, { issueId: f.issueId }, f.deps)).sources).toMatchObject([
    { state: "VISIBLE", reference: { kind: "ASSET", id: asset.id } }
  ]);
  const orderLink = { taskId: f.task.id, assetId: asset.id, expectedRevision: 0, idempotencyKey: randomUUID(),
    reason: "Link the same original pump to this work order" };
  await expect(changeWorkOrderAsset(f.actor, { ...orderLink, assetId: foreign.id }, f.deps)).rejects.toBeInstanceOf(WorkOrderAccessError);
  await changeWorkOrderAsset(f.actor, orderLink, f.deps);
  await expect(changeWorkOrderAsset(f.actor, orderLink, f.deps)).resolves.toEqual({ recorded: true });
  expect((await readWorkOrderAssets(f.actor, { taskId: f.task.id }, f.deps)).current).toMatchObject({ state: "LINKED", assetId: asset.id });
  await changeWorkOrderAsset(f.actor, { ...orderLink, expectedRevision: 1, assetId: null, idempotencyKey: randomUUID() }, f.deps);
  expect((await readWorkOrderAssets(f.actor, { taskId: f.task.id }, f.deps)).items).toMatchObject([{ state: "CLEARED" }, { state: "LINKED", assetId: asset.id }]);
  const plan = { assetId: asset.id, kind: "PLAN", expectedVersion: 0, effectiveOn: today, budget: { amount: "4500.05", currency: "MAD" },
    reason: "Plan replacement of the original installed pump", idempotencyKey: randomUUID() };
  await expect(recordAssetLifecycle(f.actor, plan, f.deps)).resolves.toEqual({ version: 1 });
  await expect(recordAssetLifecycle(f.actor, plan, f.deps)).resolves.toEqual({ version: 1 });
  const replacement = { assetId: asset.id, kind: "REPLACE", expectedVersion: 1, effectiveOn: today,
    reason: "Record installation of the original replacement pump", successorTag: "PUMP-0043", idempotencyKey: randomUUID() };
  await expect(recordAssetLifecycle(f.actor, { ...replacement, successorTag: "FOREIGN-PUMP" }, f.deps)).rejects.toBeInstanceOf(AssetConflictError);
  await expect(recordAssetLifecycle(f.actor, replacement, f.deps)).resolves.toEqual({ version: 2 });
  await expect(recordAssetLifecycle(f.actor, { assetId: asset.id, kind: "DISPOSE", expectedVersion: 2, effectiveOn: today,
    reason: "Retire the original pump using the recycling certificate", method: "RECYCLED", reference: "CERT-42", idempotencyKey: randomUUID() }, f.deps)).resolves.toEqual({ version: 3 });
  expect(await readAssetLifecycle(f.actor, asset.id, undefined, f.deps)).toMatchObject({
    current: "DISPOSE", items: [{ kind: "DISPOSE", method: "RECYCLED" }, { kind: "REPLACE", successor: { id: successor.id } },
      { kind: "PLAN", budget: { amount: "4500.05", currency: "MAD" } }]
  });
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  expect(await generateRecurringOperations(f.actor, { propertyId: f.property.id, from: tomorrow, until: tomorrow },
    { ...f.deps, now: new Date() })).toMatchObject({ created: 0 });
  expect(await readAssetPreventiveSchedule(f.actor, asset.id, db)).toMatchObject({ schedule: { enabled: false }, tasks: [{ state: "PLANNED" }] });
  await withTenant(db, f.organizationId, tx => tx.roleAssignment.update({
    where: { id: f.grants["asset_cost:view"] }, data: { archivedAt: new Date() }
  }));
  const { cost, ...operational } = data.fields;
  await saveAsset(f.actor, { assetId: asset.id, expectedRevision: 1, idempotencyKey: randomUUID(),
    reason: "Record the condition after original inspection", fields: { ...operational, condition: "FAIR" } }, f.deps);
  const restricted = await getAsset(f.actor, { assetId: asset.id }, f.deps);
  expect(restricted.asset.canEditCost).toBe(false);
  expect(JSON.stringify(restricted)).not.toContain(cost.amount);
  expect(JSON.stringify(await readAssetLifecycle(f.actor, asset.id, undefined, f.deps))).not.toContain("4500.05");
  await expect(withTenant(db, f.organizationId, tx => tx.$executeRawUnsafe(
    "UPDATE asset_revision SET name='changed' WHERE organization_id=$1::uuid AND asset_id=$2::uuid", f.organizationId, asset.id)))
    .rejects.toThrow(/append-only/u);
  expect((await originals(f)).money).toBe(0);
});
