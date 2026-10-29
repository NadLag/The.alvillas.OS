import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { encryptSecret } from "@/platform/auth/secret-encryption";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { createOwnerPayout, getOwnerPayout, submitOwnerPayout, OwnerPayoutAccessError, OwnerPayoutConflictError } from "@/modules/finance/application/owner-payout-service";
import { OwnerPayoutPolicyUnavailableError } from "@/modules/finance/application/owner-payout-policy";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { Money } from "@/platform/money/money";
import { decideApproval, getApproval } from "@/platform/approvals/approval-service";
import { ApprovalAccessError, ApprovalConflictError } from "@/platform/approvals/approval";
import { NotificationRepository } from "@/platform/notifications/notification-repository";
import { scheduleOwnerPayout,payOwnerPayout,reverseOwnerPayout,failOwnerPayout,cancelOwnerPayout } from "@/modules/finance/application/owner-payout-payment-service";
import { OwnerPayoutConfigurationError } from "@/modules/finance/application/owner-payout-service";
import { listAuditHistory,exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";
import { getOwnerPayoutWorkspace } from "@/modules/finance/application/owner-payout-workspace-service";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";
import { AutomationAccessError,saveAutomationRule,previewAutomation,enqueueAutomationEvent,executeAutomationRun,replayAutomation } from "@/platform/automation/service";
import { AutomationRepository } from "@/platform/automation/repository";
import { readOwnerLedgerStatement } from "@/platform/ledger/owner-statements";
import { changeReservation } from "@/modules/reservations/application/reservation-management-service";
import { createExpenseDraft, submitExpense } from "@/modules/finance/application/expense-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;

async function fixture() {
  const org = randomUUID();
  await admin.organization.create({ data: { id: org, name: "Dedicated native payout acceptance", baseCurrency: "MAD" } });
  await ensureStandardIdentitySetup(org, { db });
  const source = await withTenant(db, org, async tx => {
    await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated payout operator" } });
    const account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const owner = await tx.owner.create({ data: { organizationId: org, displayName: "Dedicated payout beneficiary" } });
    const otherOwner = await tx.owner.create({ data: { organizationId: org, displayName: "Unrelated private payout owner" } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Dedicated payout villa", addressLine1: "Local acceptance", city: "Marrakech",
      propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    await tx.propertyOwner.create({ data: { organizationId: org, propertyId: property.id, ownerId: owner.id } });
    const bank = await new FinanceRepository(tx, org).ensureLedgerAccount({ code: "PAYOUT_QA_BANK", name: "Private company funding bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
    const encrypted = encryptSecret("Dedicated local nonproduction bank reference");
    const method = await tx.ownerPayoutMethod.create({ data: { organizationId: org, ownerId: owner.id, label: "Dedicated beneficiary method", methodType: "BANK_TRANSFER",
      accountHolderName: "Dedicated payout beneficiary", currency: "MAD", countryCode: "MA", detailsEncrypted: encrypted, maskedAccount: "****7890" } });
    const role = await tx.role.create({ data: { organizationId: org, key: `payout_qa_${randomUUID()}`, name: "Scoped payout acceptance" } });
    const permissions = await tx.permission.findMany({ where: { organizationId: org, key: { in: ["financial_transaction:view", "financial_transaction:create"] } } });
    expect(permissions).toHaveLength(2);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: org, roleId: role.id, permissionId: permission.id })) });
    const ownerGrant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, personId: person.id, userAccountId: account.id, scopeType: "owner", scopeId: owner.id, validFrom: new Date("2020-01-01") } });
    const bankGrant = await tx.roleAssignment.create({ data: { organizationId: org, roleId: role.id, personId: person.id, userAccountId: account.id, scopeType: "financial_record", scopeId: bank.id, validFrom: new Date("2020-01-01") } });
    return { account, owner, otherOwner, property, bank, method, encrypted, ownerGrant, bankGrant };
  });
  const ctx = { organizationId: org, actorId: source.account.id, authContext: await authContextForAccount(org, source.account.id, { db }) };
  const input = { propertyId: source.property.id, ownerId: source.owner.id, payoutMethodId: source.method.id, fundingAccountId: source.bank.id,
    amount: "9999999999999999.99", currency: "MAD", purpose: "Dedicated owner payout draft", reason: "Dedicated payout persistence acceptance", idempotencyKey: randomUUID() };
  return { ...source, org, ctx, input };
}

type Fixture=Awaited<ReturnType<typeof fixture>>;
async function submissionPolicy(f:Fixture,options:{balance?:string;payout?:Prisma.InputJsonObject;approval?:Prisma.InputJsonObject;timezone?:string}={}){
  await withTenant(db,f.org,async tx=>{
    const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.org,key:"financial_transaction:edit"}});
    await tx.rolePermission.create({data:{organizationId:f.org,roleId:f.ownerGrant.roleId,permissionId:permission.id}});
    if(options.timezone)await tx.property.update({where:{id:f.property.id},data:{timezone:options.timezone}});
    const config=new ConfigRuleRepository(tx,f.org);
    await config.createVersion({key:"finance.payout_schedule",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),
      value:options.payout??{cadence:"MONTHLY",schedule:{at:"09:00",month_day:"LAST"}},reason:"Dedicated configured payout calendar"});
    await config.createVersion({key:"finance.approval_thresholds",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),
      value:options.approval??{thresholds:[]},reason:"Dedicated explicit payout approval policy"});
    await config.createVersion({key:"finance.accounting_periods",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),
      value:{timezone:"UTC",allow_early_close:false,max_reopen_seconds:60},reason:"Dedicated accounting calendar"});
    const finance=new FinanceRepository(tx,f.org),claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Owner payable",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
    const amount=Money.of(options.balance??"10000.00","MAD");
    await finance.createFinancialTransaction({reference:`QA-PAYOUT-OPENING:${randomUUID()}`,idempotencyKey:randomUUID(),createdBy:f.account.id,occurredAt:new Date("2026-01-01"),description:"Dedicated owner opening movement",
      postings:[{ledgerAccountId:f.bank.id,amount,side:"DEBIT",bucket:"REVENUE_RECEIPT",dimensions:{owner_id:f.owner.id,property_id:f.property.id}},
        {ledgerAccountId:claim.id,amount,side:"CREDIT",bucket:"OWNER_REVENUE",dimensions:{owner_id:f.owner.id,property_id:f.property.id}}]});
  });
  return {...f.ctx,authContext:await authContextForAccount(f.org,f.account.id,{db})};
}

async function reviewer(f:Fixture,financial=true){
  const identity=await withTenant(db,f.org,async tx=>{
    const person=await tx.person.create({data:{organizationId:f.org,displayName:"Dedicated payout reviewer"}});
    const account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}});
    const role=await tx.role.create({data:{organizationId:f.org,key:`payout_reviewer_${randomUUID()}`,name:"Independent payout reviewer"}});
    const permissions=await tx.permission.findMany({where:{organizationId:f.org,key:{in:financial?["financial_transaction:view","financial_transaction:approve","financial_transaction:reject"]:["property:view","property:approve","property:reject"]}}});
    expect(permissions).toHaveLength(3);await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:role.id,permissionId:permission.id}))});
    const grant=await tx.roleAssignment.create({data:{organizationId:f.org,roleId:role.id,personId:person.id,userAccountId:account.id,scopeType:"owner",scopeId:f.owner.id,validFrom:new Date("2020-01-01")}});
    return{person,account,grant};
  });
  return{...identity,actor:{organizationId:f.org,accountId:identity.account.id,authContext:await authContextForAccount(f.org,identity.account.id,{db})}};
}

async function paymentGrant(f:Fixture){
  await withTenant(db,f.org,async tx=>{
    const permissions=await tx.permission.findMany({where:{organizationId:f.org,key:{in:["financial_transaction:pay","financial_transaction:void"]}}});expect(permissions).toHaveLength(2);
    await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:f.ownerGrant.roleId,permissionId:permission.id}))});
  });
  return{...f.ctx,authContext:await authContextForAccount(f.org,f.account.id,{db})};
}
async function readyForPayment(expectedSettlementAt="2020-01-01T09:00:00Z",review=false){
  const f=await fixture(),receiver=review?await reviewer(f):null;
  let ctx=await submissionPolicy(f,{payout:{cadence:"OTA_SPLIT_EXPECTED_SETTLEMENT",hold_days:0},...(receiver?{approval:{thresholds:[{key:"review_before_payment",requires_approval_from:["owner"]}],
    routing:{owner:{people:[receiver.person.id],roles:[],assigned:false,channels:["in_app"]}}}}:{})});
  const draft=await createOwnerPayout(ctx,{...f.input,amount:"500.25",expectedSettlementAt},{db});
  let submitted=await submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated payment-ready source submission"},{db});
  if(receiver){
    const approval=await getApproval(receiver.actor,submitted.approvalId!,{db});
    await decideApproval(receiver.actor,{id:approval.id,stageId:approval.stageId,decision:"APPROVED",reason:"Dedicated approved payment-ready source"},{db});
    const row=await getOwnerPayout(ctx,draft.id,{db});submitted={...submitted,version:row.version,state:row.state};
  }
  const schedule={id:draft.id,expectedVersion:submitted.version,scheduledFor:new Date(expectedSettlementAt).toISOString(),reason:"Dedicated exact planned owner payout"};
  const scheduled=await scheduleOwnerPayout(ctx,schedule,{db});
  const restricted=ctx;ctx=await paymentGrant(f);
  return{f,ctx,restricted,receiver,draft,schedule,scheduled,command:{id:draft.id,expectedVersion:scheduled.version,paymentReference:"QA-OWNER-BANK-TRANSFER",reason:"Dedicated completed manual bank transfer"}};
}
async function unrelatedOwnerOpening(f:Fixture){
  const created=await withTenant(db,f.org,async tx=>{
    const finance=new FinanceRepository(tx,f.org),claim=await tx.ledgerAccount.findFirstOrThrow({where:{organizationId:f.org,code:"OWNER_PAYABLE"}});
    const amount=Money.of("777.77","MAD"),dimensions={owner_id:f.otherOwner.id,property_id:f.property.id};
    return finance.createFinancialTransaction({reference:`QA-OTHER-OWNER:${randomUUID()}`,idempotencyKey:randomUUID(),createdBy:f.account.id,occurredAt:new Date("2026-01-01"),description:"Unrelated owner preserved opening",
      postings:[{ledgerAccountId:f.bank.id,amount,side:"DEBIT",bucket:"REVENUE_RECEIPT",dimensions},{ledgerAccountId:claim.id,amount,side:"CREDIT",bucket:"OWNER_REVENUE",dimensions}]});
  });
  return withTenant(db,f.org,tx=>tx.financialTransaction.findUniqueOrThrow({where:{id:created.id}}));
}
async function closing(f:Fixture,other=false){
  return withTenant(db,f.org,async tx=>(await readOwnerLedgerStatement(tx,f.org,{ownerId:other?f.otherOwner.id:f.owner.id,ownerName:"Dedicated acceptance owner",
    propertyId:f.property.id,propertyName:f.property.name,currency:"MAD",startsAt:new Date("2020-01-01"),endsAt:new Date("2099-01-01")})).closingBalance.toJSON().amount);
}

describe("native owner payout persistence on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url });await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url);scoped.username = "alvillas_ops_tests";scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect();await admin?.$disconnect(); });

  it("preserves one actual financial approval source and append-only payout recipients after invoice integration", async () => {
    const f = await fixture(), receiver = await reviewer(f);
    const ctx = await submissionPolicy(f, { approval: { thresholds: [{ key: "composed_source_review", requires_approval_from: ["owner"] }],
      routing: { owner: { people: [receiver.person.id], roles: [], assigned: false, channels: ["in_app"] } } } });
    const draft = await createOwnerPayout(ctx, { ...f.input, amount: "500.25" }, { db });
    const submitted = await submitOwnerPayout(ctx, { id: draft.id, expectedVersion: 1, reason: "Actual composed financial approval source" }, { db });
    const original = await withTenant(db, f.org, tx => tx.approvalRequest.findUniqueOrThrow({ where: { id: submitted.approvalId! }, include: { recipients: true } }));
    await withTenant(db, f.org, async tx => {
      const role = await tx.role.create({ data: { organizationId: f.org, key: "composed_expense_author", name: "Actual composed expense source author" } });
      const permissions = await tx.permission.findMany({ where: { organizationId: f.org } });
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
      await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, personId: f.account.personId, userAccountId: f.account.id, scopeType: "organization", validFrom: new Date("2000-01-01") } });
      const expenseReview = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["expense:view", "expense:approve", "expense:reject"] } } });
      expect(expenseReview).toHaveLength(3);
      await tx.rolePermission.createMany({ data: expenseReview.map(permission => ({ organizationId: f.org, roleId: receiver.grant.roleId, permissionId: permission.id })) });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: f.property.id,
        effectiveFrom: new Date("2020-01-01"), reason: "Actual second submitted financial source", value: { default_treatment: "OWNER_PAID" } });
    });
    const expenseActor = { ...ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
    const expense = await createExpenseDraft(expenseActor, { propertyId: f.property.id, fundingAccountId: f.bank.id, amount: "1.00", currency: "MAD", category: "maintenance",
      purpose: "Actual second financial approval source", occurredOn: "2026-10-28", idempotencyKey: randomUUID(), reason: "Create actual submitted expense source" }, { db });
    const expenseSubmitted = await submitExpense(expenseActor, { id: expense.id, expectedVersion: expense.version, reason: "Submit actual second financial source" }, { db });
    expect(expenseSubmitted.state).toBe("PENDING_APPROVAL");
    await expect(withTenant(db, f.org, tx => tx.approvalRequest.create({ data: { organizationId: f.org, payoutId: draft.id, expenseId: expense.id, propertyId: f.property.id,
      requestedBy: original.requestedBy, title: original.title, details: original.details, routingSnapshot: original.routingSnapshot as Prisma.InputJsonObject,
      idempotencyKey: "composed-source-forgery:" + randomUUID() } }))).rejects.toThrow(/approval_request_one_financial_source/iu);
    await expect(withTenant(db, f.org, tx => tx.approvalRecipient.update({ where: { id: original.recipients[0].id }, data: { userAccountId: f.account.id } }))).rejects.toThrow(/approval recipients are immutable/iu);
    await expect(withTenant(db, f.org, async tx => {
      await tx.approvalRecipient.delete({ where: { id: original.recipients[0].id } });
      throw Error("Controlled rollback if the append-only guard is absent");
    })).rejects.toThrow(/approval history cannot be deleted/iu);
    const retained = await withTenant(db, f.org, tx => tx.approvalRequest.findUniqueOrThrow({ where: { id: original.id }, include: { recipients: true } }));
    expect(retained).toEqual(original);
    const review = await getApproval(receiver.actor, original.id, { db }); expect(review.canApprove).toBe(true);
    await decideApproval(receiver.actor, { id: review.id, stageId: review.stageId, decision: "APPROVED", reason: "Approve the retained actual payout source" }, { db });
    expect((await getOwnerPayout(ctx, draft.id, { db })).state).toBe("APPROVED");
  });

  it("stores exact draft cents and attributed reads without creating a payment or disclosing bank secrets", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    const view = await getOwnerPayout(f.ctx, created.id, { db });
    expect(view).toMatchObject({ amount: f.input.amount, currency: "MAD", state: "DRAFT", version: 1, paidAt: null,canViewWorkspace:false,canViewLedger:false });
    expect(JSON.stringify(view)).not.toContain(f.encrypted);expect(JSON.stringify(view)).not.toContain("Dedicated local nonproduction bank reference");
    expect(JSON.stringify(view)).not.toContain(f.bank.id);expect(JSON.stringify(view)).not.toContain(f.bank.name);
    await withTenant(db, f.org, async tx => {
      expect(await tx.financialTransaction.count()).toBe(0);expect(await tx.posting.count()).toBe(0);
      expect(await tx.auditLog.count({ where: { resourceId: created.id, action: "finance.owner_payout.created", actorId: f.account.id } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: created.id, action: "finance.owner_payout.viewed", actorId: f.account.id } })).toBe(1);
    });
  });

  it("serializes duplicate creation identities and rejects a conflicting request without duplicate business rows", async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => createOwnerPayout(f.ctx, { ...f.input, idempotencyKey: index % 2 ? f.input.idempotencyKey.toUpperCase() : f.input.idempotencyKey }, { db })));
    expect(new Set(results.map(row => row.id)).size).toBe(1);expect(results.filter(row => !row.idempotent)).toHaveLength(1);
    await expect(createOwnerPayout(f.ctx, { ...f.input, purpose: "Conflicting payout intent" }, { db })).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    await withTenant(db, f.org, async tx => { expect(await tx.ownerPayout.count()).toBe(1);expect(await tx.auditLog.count({ where: { action: "finance.owner_payout.created" } })).toBe(1); });
  });

  it("requires both current and caller authority and rejects another owner's scope before creation", async () => {
    const f = await fixture();
    await expect(createOwnerPayout({ ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set(), assignments: [] } }, f.input, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await expect(createOwnerPayout(f.ctx, { ...f.input, ownerId: f.otherOwner.id }, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.ownerGrant.id }, data: { validTo: new Date("2021-01-01") } }));
    await expect(createOwnerPayout(f.ctx, f.input, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect(await withTenant(db, f.org, tx => tx.ownerPayout.count())).toBe(0);
  });

  it("keeps funding permission independent while allowing the beneficiary-scoped payout summary", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.bankGrant.id }, data: { validTo: new Date("2021-01-01") } }));
    await expect(createOwnerPayout(f.ctx, { ...f.input, idempotencyKey: randomUUID() }, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect((await getOwnerPayout(f.ctx, created.id, { db })).amount).toBe(f.input.amount);
  });

  it("enforces tenant isolation in both the application and PostgreSQL RLS", async () => {
    const a = await fixture(), b = await fixture(), created = await createOwnerPayout(b.ctx, b.input, { db });
    await expect(getOwnerPayout(a.ctx, created.id, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect(await withTenant(db, a.org, tx => tx.ownerPayout.findMany({ where: { id: created.id } }))).toEqual([]);
    await expect(createOwnerPayout(a.ctx, { ...a.input, propertyId: b.property.id }, { db })).rejects.toBeInstanceOf(OwnerPayoutAccessError);
  });

  it("rejects skipped approval, unaudited rewrites and business deletion without changing the original row version", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    const original = await withTenant(db, f.org, tx => tx.$queryRaw<Array<{ version: string }>>(Prisma.sql`SELECT xmin::text AS version FROM owner_payout WHERE id=${created.id}::uuid`));
    await expect(withTenant(db, f.org, tx => tx.ownerPayout.update({ where: { id: created.id }, data: { state: "PAID", version: 2 } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.ownerPayout.update({ where: { id: created.id }, data: { purpose: "Unaudited attempted rewrite", version: 2 } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.ownerPayout.delete({ where: { id: created.id } }))).rejects.toThrow();
    expect(await withTenant(db, f.org, tx => tx.$queryRaw(Prisma.sql`SELECT xmin::text AS version FROM owner_payout WHERE id=${created.id}::uuid`))).toEqual(original);
    expect((await getOwnerPayout(f.ctx, created.id, { db })).purpose).toBe(f.input.purpose);
    expect(await withTenant(db, f.org, tx => tx.financialTransaction.count())).toBe(0);
  });

  it("freezes configured calendar, holdback and explicit automatic approval without paying or duplicating submission",async()=>{
    const f=await fixture(),ctx=await submissionPolicy(f,{timezone:"Africa/Casablanca",payout:{cadence:"WEEKLY",schedule:{at:"09:00",weekday:1},holdback_bps:2000}});
    const draft=await createOwnerPayout(ctx,{...f.input,amount:"500.25"},{db}),command={id:draft.id,expectedVersion:1,reason:"Dedicated configured owner payout submission"};
    const results=await Promise.all(Array.from({length:4},()=>submitOwnerPayout(ctx,command,{db})));
    expect(results.filter(result=>!result.idempotent)).toHaveLength(1);expect(results.every(result=>result.state==="APPROVED"&&result.version===3)).toBe(true);
    await withTenant(db,f.org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}});
      expect(row.eligibleAt?.getUTCDay()).toBe(1);expect(row.eligibleAt?.toISOString().slice(11)).toBe("09:00:00.000Z");expect(row.methodSnapshotHash).toMatch(/^[0-9a-f]{64}$/u);
      const instant=z.object({submittedAt:z.iso.datetime()}).parse(row.policySnapshot).submittedAt;
      expect(row.eligibleAt!.getTime()-new Date(instant).getTime()).toBeGreaterThanOrEqual(0);
      expect(row.eligibleAt!.getTime()-new Date(instant).getTime()).toBeLessThanOrEqual(7*24*60*60*1000);
      expect(row.policySnapshot).toMatchObject({timezone:"Africa/Casablanca",payout:{holdbackAmount:{amount:"2000.00",currency:"MAD"},payableAmount:{amount:"8000.00",currency:"MAD"}},stages:[]});
      expect(await tx.financialTransaction.count()).toBe(1);expect(await tx.posting.count()).toBe(2);
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.submitted"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.approved"}})).toBe(1);
    });
    await expect(submitOwnerPayout(ctx,{...command,reason:"Conflicting repeated payout submission"},{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
  });

  it("serializes concurrent owner commitments and leaves a rejected excess source as an untouched draft",async()=>{
    const f=await fixture(),ctx=await submissionPolicy(f,{balance:"700.25"});
    const drafts=await Promise.all(Array.from({length:2},()=>createOwnerPayout(ctx,{...f.input,amount:"500.25",idempotencyKey:randomUUID()},{db})));
    const results=await Promise.allSettled(drafts.map(draft=>submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated concurrent payable commitment"},{db})));
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    await withTenant(db,f.org,async tx=>{
      expect(await tx.ownerPayout.count({where:{state:"APPROVED"}})).toBe(1);expect(await tx.ownerPayout.count({where:{state:"DRAFT",version:1,policySnapshot:{equals:Prisma.DbNull}}})).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(1);expect(await tx.approvalRequest.count()).toBe(0);
    });
  });

  it("uses the attributed OTA expected instant across a 25-hour calendar day and rejects unaudited source changes",async()=>{
    const f=await fixture(),ctx=await submissionPolicy(f,{timezone:"America/Denver",payout:{cadence:"OTA_SPLIT_EXPECTED_SETTLEMENT",hold_days:1}});
    const input={...f.input,amount:"500.25",expectedSettlementAt:"2026-10-31T12:00:00-06:00"};
    const draft=await createOwnerPayout(ctx,input,{db});
    await expect(submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated attributed expected settlement"},{db})).resolves.toMatchObject({state:"APPROVED"});
    await withTenant(db,f.org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}});
      expect(row.expectedSettlementAt?.toISOString()).toBe("2026-10-31T18:00:00.000Z");expect(row.eligibleAt?.toISOString()).toBe("2026-11-01T19:00:00.000Z");
    });
    await expect(withTenant(db,f.org,tx=>tx.ownerPayout.update({where:{id:draft.id},data:{expectedSettlementAt:new Date("2026-10-30"),version:4}}))).rejects.toThrow();
    const missing=await createOwnerPayout(ctx,{...f.input,amount:"500.25",idempotencyKey:randomUUID()},{db});
    await expect(submitOwnerPayout(ctx,{id:missing.id,expectedVersion:1,reason:"Missing expected settlement cannot be inferred"},{db})).rejects.toBeInstanceOf(OwnerPayoutPolicyUnavailableError);
    const unauditedId=randomUUID();
    await expect(withTenant(db,f.org,tx=>tx.ownerPayout.create({data:{id:unauditedId,organizationId:f.org,propertyId:f.property.id,ownerId:f.owner.id,
      fundingAccountId:f.bank.id,payoutMethodId:f.method.id,amount:"1.00",currency:"MAD",purpose:"Unaudited expected settlement",idempotencyKey:randomUUID(),createdBy:f.account.id,updatedBy:f.account.id,
      expectedSettlementAt:new Date("2026-11-01")}}))).rejects.toThrow();
  });

  it("routes ordered financial approvals through the shared inbox and denies operational, stale and unselected authority",async()=>{
    const f=await fixture(),first=await reviewer(f),second=await reviewer(f),operational=await reviewer(f,false);
    const routing=(personId:string)=>({people:[personId],roles:[],assigned:false,channels:["in_app"]});
    const ctx=await submissionPolicy(f,{approval:{thresholds:[{key:"ordered_owner_payout",requires_approval_from:["manager_owner"]}],
      routing:{manager:routing(first.person.id),owner:routing(second.person.id)}}});
    const draft=await createOwnerPayout(ctx,{...f.input,amount:"500.25"},{db}),submitted=await submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated ordered payout approval"},{db});
    expect(submitted).toMatchObject({state:"PENDING_APPROVAL",version:2});expect(submitted.approvalId).toBeTruthy();
    const id=submitted.approvalId!;
    const initial=await getApproval(first.actor,id,{db});expect(initial.canApprove).toBe(true);expect(initial.financial?.amount).toBe("500.25");
    expect((await getApproval(second.actor,id,{db})).canApprove).toBe(false);
    const stages=await withTenant(db,f.org,tx=>tx.approvalStage.findMany({where:{approvalId:id},orderBy:{position:"asc"}}));expect(stages).toHaveLength(2);
    await withTenant(db,f.org,async tx=>{
      expect(await tx.notification.count({where:{targetId:id,recipientId:first.account.id,kind:"approval_requested"}})).toBe(1);
      expect(await tx.notification.count({where:{targetId:id,recipientId:second.account.id,kind:"approval_requested"}})).toBe(0);
    });
    const secondCommand={id,stageId:stages[1].id,decision:"APPROVED",reason:"Dedicated owner second-stage approval"};
    await expect(decideApproval(second.actor,secondCommand,{db})).rejects.toBeInstanceOf(ApprovalConflictError);
    await expect(decideApproval({...first.actor,authContext:{...first.actor.authContext,permissions:new Set(),assignments:[]}},
      {id,stageId:stages[0].id,decision:"APPROVED",reason:"Caller restrictions remain authoritative"},{db})).rejects.toBeInstanceOf(ApprovalAccessError);
    const firstCommand={id,stageId:stages[0].id,decision:"APPROVED",reason:"Dedicated manager first-stage approval"};
    await expect(getApproval(operational.actor,id,{db})).rejects.toBeInstanceOf(ApprovalAccessError);
    await expect(decideApproval(operational.actor,firstCommand,{db})).rejects.toBeInstanceOf(ApprovalAccessError);
    await decideApproval(first.actor,firstCommand,{db});await decideApproval(first.actor,firstCommand,{db});
    const sourceEvent=await withTenant(db,f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{idempotencyKey:`approval:${id}:stage:${stages[0].id}:requested`}}));
    expect(await withTenant(db,f.org,tx=>new NotificationRepository(tx,f.org).approvalDeliveryAllowed(id,first.account.id,sourceEvent.id))).toBe(false);
    expect((await getApproval(second.actor,id,{db})).canApprove).toBe(true);
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:second.grant.id},data:{validTo:new Date("2021-01-01")}}));
    await expect(decideApproval(second.actor,secondCommand,{db})).rejects.toBeInstanceOf(ApprovalAccessError);
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:second.grant.id},data:{validTo:null}}));
    await decideApproval(second.actor,secondCommand,{db});
    expect((await getOwnerPayout(ctx,draft.id,{db})).state).toBe("APPROVED");
    await withTenant(db,f.org,async tx=>{
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.approval_stage_decided"}})).toBe(2);
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.approved",actorId:second.account.id}})).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(1);
    });
  });

  it("selects effective agreement versions for new payouts and preserves previously submitted financial terms",async()=>{
    const f=await fixture(),ctx=await submissionPolicy(f);
    const agreement=await withTenant(db,f.org,async tx=>{
      const agreement=await tx.managementAgreement.create({data:{organizationId:f.org,propertyId:f.property.id,reference:"Dedicated effective payout agreement",effectiveFrom:new Date("2020-01-01")}});
      const rule=await new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.payout_schedule",scopeType:"agreement",scopeId:agreement.id,effectiveFrom:new Date("2020-01-01"),
        value:{cadence:"MONTHLY",holdback_bps:3000,schedule:{at:"09:00",month_day:"LAST"}},reason:"Dedicated original agreement payout terms"});
      return{...agreement,rule};
    });
    const first=await createOwnerPayout(ctx,{...f.input,amount:"400.00"},{db});
    await submitOwnerPayout(ctx,{id:first.id,expectedVersion:1,reason:"Dedicated original agreement submission"},{db});
    const original=await withTenant(db,f.org,tx=>tx.ownerPayout.findUniqueOrThrow({where:{id:first.id}}));
    const updated=await withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.payout_schedule",scopeType:"agreement",scopeId:agreement.id,effectiveFrom:new Date("2020-01-02"),
      value:{cadence:"MONTHLY",holdback_bps:5000,schedule:{at:"10:00",month_day:"LAST"}},reason:"Dedicated revised agreement payout terms"}));
    const second=await createOwnerPayout(ctx,{...f.input,amount:"400.00",idempotencyKey:randomUUID()},{db});
    await submitOwnerPayout(ctx,{id:second.id,expectedVersion:1,reason:"Dedicated revised agreement submission"},{db});
    await withTenant(db,f.org,async tx=>{
      expect(await tx.ownerPayout.findUniqueOrThrow({where:{id:first.id}})).toEqual(original);
      expect(original.policySnapshot).toMatchObject({payout:{holdbackAmount:{amount:"3000.00"}},payoutRule:{config_rule_id:agreement.rule.id,config_rule_version:agreement.rule.version,config_rule_scope_type:"agreement"}});
      expect((await tx.ownerPayout.findUniqueOrThrow({where:{id:second.id}})).policySnapshot).toMatchObject({payout:{holdbackAmount:{amount:"5000.00"}},payoutRule:{config_rule_id:updated.id,config_rule_version:updated.version}});
    });
  });

  it("uses the booking's immutable owner policy instead of a later property payout or approval waiver",async()=>{
    const f=await fixture(),ctx=await submissionPolicy(f,{timezone:"America/Denver",payout:{cadence:"MONTHLY",holdback_bps:9000,schedule:{at:"09:00",month_day:"LAST"}}});
    const source=await withTenant(db,f.org,async tx=>{
      const config=new ConfigRuleRepository(tx,f.org),rule=await config.createVersion({key:"finance.commission",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),
        value:{rate_bps:2000,basis:"GROSS_ACCOMMODATION",accrual_event:"ON_CONFIRMATION"},reason:"Dedicated original owner booking commission"});
      const reservation=await tx.reservation.create({data:{organizationId:f.org,propertyId:f.property.id,reference:`PAYOUT-BOOKING-${randomUUID()}`,source:"MANUAL",guestName:"Dedicated fictional guest",
        checkIn:new Date("2026-03-01"),checkOut:new Date("2026-03-08"),nights:7,idempotencyKey:randomUUID(),createdBy:f.account.id}});
      const snapshot=await new FinanceRepository(tx,f.org).createCommissionSnapshot({reservationId:reservation.id,propertyId:f.property.id,ownerId:f.owner.id,configRuleId:rule.id,
        shareBps:10000,commissionRateBps:2000,commissionBasis:"GROSS_ACCOMMODATION",accrualEvent:"ON_CONFIRMATION",createdBy:f.account.id,
        snapshotValue:{config_rule_version:rule.version,payout_rule:{cadence:"AFTER_CHECKOUT",hold_days:1,holdback_bps:1000},approval_thresholds:{thresholds:[]}}});
      return{reservation,snapshot};
    });
    const draft=await createOwnerPayout(ctx,{...f.input,reservationId:source.reservation.id,amount:"500.25"},{db});
    await submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated original booking payout submission"},{db});
    await withTenant(db,f.org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}});
      expect(row.eligibleAt?.toISOString()).toBe("2026-03-09T06:00:00.000Z");
      expect(row.policySnapshot).toMatchObject({ownershipSnapshotId:source.snapshot.id,payout:{cadence:"AFTER_CHECKOUT",holdbackAmount:{amount:"1000.00"}},
        payoutRule:{commissionSnapshotId:source.snapshot.id,config_rule_scope_type:"reservation_snapshot"}});
      expect(await tx.commissionSnapshot.findUniqueOrThrow({where:{id:source.snapshot.id}})).toEqual(source.snapshot);
    });
  });

  it("requires native booking completion before freezing a per-booking payout and its configured hold",async()=>{
    const f=await fixture();await submissionPolicy(f,{payout:{cadence:"MONTHLY",schedule:{at:"09:00",month_day:"LAST"}}});
    const source=await withTenant(db,f.org,async tx=>{
      const rule=await new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.commission",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),
        value:{rate_bps:2000,basis:"GROSS_ACCOMMODATION",accrual_event:"ON_CONFIRMATION"},reason:"Dedicated per-booking completion policy"});
      const reservation=await tx.reservation.create({data:{organizationId:f.org,propertyId:f.property.id,reference:`PAYOUT-COMPLETION-${randomUUID()}`,source:"MANUAL",guestName:"Dedicated fictional completion guest",
        checkIn:new Date("2020-03-01"),checkOut:new Date("2020-03-08"),nights:7,idempotencyKey:randomUUID(),createdBy:f.account.id}});
      const snapshot=await new FinanceRepository(tx,f.org).createCommissionSnapshot({reservationId:reservation.id,propertyId:f.property.id,ownerId:f.owner.id,configRuleId:rule.id,
        shareBps:10000,commissionRateBps:2000,commissionBasis:"GROSS_ACCOMMODATION",accrualEvent:"ON_CONFIRMATION",createdBy:f.account.id,
        snapshotValue:{config_rule_version:rule.version,payout_rule:{cadence:"PER_BOOKING",hold_days:2},approval_thresholds:{thresholds:[]}}});
      const role=await tx.role.create({data:{organizationId:f.org,key:`payout_completion_${randomUUID()}`,name:"Dedicated native booking completion"}});
      const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.org,key:"reservation:edit"}});
      await tx.rolePermission.create({data:{organizationId:f.org,roleId:role.id,permissionId:permission.id}});
      await tx.roleAssignment.create({data:{organizationId:f.org,roleId:role.id,personId:f.account.personId,userAccountId:f.account.id,scopeType:"property",scopeId:f.property.id,validFrom:new Date("2020-01-01")}});
      return{reservation,snapshot};
    });
    const ctx={...f.ctx,authContext:await authContextForAccount(f.org,f.account.id,{db})};
    const draft=await createOwnerPayout(ctx,{...f.input,reservationId:source.reservation.id,amount:"500.25"},{db});
    const command={id:draft.id,expectedVersion:1,reason:"Dedicated per-booking completion submission"};
    await expect(submitOwnerPayout(ctx,command,{db})).rejects.toThrow();
    expect((await getOwnerPayout(ctx,draft.id,{db})).state).toBe("DRAFT");
    let booking=source.reservation;
    for(const status of ["GUEST_PREPARATION","CHECKED_IN","CHECKED_OUT","FINANCIAL_RECONCILIATION","CLOSED"] as const){
      booking=await changeReservation({...ctx,personId:f.account.personId},{reservationId:booking.id,expectedVersion:booking.version,operation:"TRANSITION",status,
        reason:"Dedicated native completed and reconciled booking",idempotencyKey:randomUUID()},{db,requestId:randomUUID()});
      if(status!=="CLOSED")await expect(submitOwnerPayout(ctx,command,{db})).rejects.toThrow();
    }
    await submitOwnerPayout(ctx,command,{db});await submitOwnerPayout(ctx,command,{db});
    await withTenant(db,f.org,async tx=>{
      const completion=await tx.reservationRevision.findFirstOrThrow({where:{organizationId:f.org,reservationId:booking.id,version:booking.version}});
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}});
      const eligible=new Date(completion.createdAt);eligible.setUTCDate(eligible.getUTCDate()+2);
      expect(row.eligibleAt).toEqual(eligible);
      expect(row.policySnapshot).toMatchObject({bookingCompletion:{revisionId:completion.id,reservationVersion:completion.version,completedAt:completion.createdAt.toISOString()},payout:{cadence:"PER_BOOKING"}});
      expect(await tx.commissionSnapshot.findUniqueOrThrow({where:{id:source.snapshot.id}})).toEqual(source.snapshot);
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.submitted"}})).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(1);expect(await tx.posting.count()).toBe(2);
    });
  });

  it("rejects a closed booking without its native reconciliation revision",async()=>{
    const f=await fixture(),ctx=await submissionPolicy(f);
    const booking=await withTenant(db,f.org,async tx=>{
      const rule=await new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.commission",scopeType:"property",scopeId:f.property.id,effectiveFrom:new Date("2020-01-01"),
        value:{rate_bps:2000,basis:"GROSS_ACCOMMODATION",accrual_event:"ON_CONFIRMATION"},reason:"Dedicated unproven completion policy"});
      const reservation=await tx.reservation.create({data:{organizationId:f.org,propertyId:f.property.id,reference:`PAYOUT-UNPROVEN-${randomUUID()}`,source:"MANUAL",guestName:"Dedicated fictional imported guest",
        status:"CLOSED",checkIn:new Date("2020-03-01"),checkOut:new Date("2020-03-08"),nights:7,idempotencyKey:randomUUID(),createdBy:f.account.id}});
      await new FinanceRepository(tx,f.org).createCommissionSnapshot({reservationId:reservation.id,propertyId:f.property.id,ownerId:f.owner.id,configRuleId:rule.id,
        shareBps:10000,commissionRateBps:2000,commissionBasis:"GROSS_ACCOMMODATION",accrualEvent:"ON_CONFIRMATION",createdBy:f.account.id,
        snapshotValue:{config_rule_version:rule.version,payout_rule:{cadence:"PER_BOOKING"},approval_thresholds:{thresholds:[]}}});
      return reservation;
    });
    const draft=await createOwnerPayout(ctx,{...f.input,reservationId:booking.id,amount:"500.25"},{db});
    await expect(submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Reject status-only completion evidence"},{db})).rejects.toThrow();
    await withTenant(db,f.org,async tx=>{
      expect((await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}})).state).toBe("DRAFT");
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.submitted"}})).toBe(0);
      expect(await tx.financialTransaction.count()).toBe(1);expect(await tx.posting.count()).toBe(2);
    });
  });

  it("serializes final reviewer approvals against one derived payable and rolls back an excessive competing decision",async()=>{
    const f=await fixture(),receiver=await reviewer(f),ctx=await submissionPolicy(f,{balance:"1000.00",approval:{thresholds:[{key:"review_owner_payout",requires_approval_from:["owner"]}],
      routing:{owner:{people:[receiver.person.id],roles:[],assigned:false,channels:["in_app"]}}}});
    const drafts=await Promise.all(Array.from({length:2},()=>createOwnerPayout(ctx,{...f.input,amount:"600.00",idempotencyKey:randomUUID()},{db})));
    const submissions=await Promise.all(drafts.map(row=>submitOwnerPayout(ctx,{id:row.id,expectedVersion:1,reason:"Dedicated competing owner payout submission"},{db})));
    const stages=await withTenant(db,f.org,tx=>tx.approvalStage.findMany({where:{approvalId:{in:submissions.map(row=>row.approvalId!)}}}));
    const results=await Promise.allSettled(stages.map(stage=>decideApproval(receiver.actor,{id:stage.approvalId,stageId:stage.id,decision:"APPROVED",reason:"Dedicated concurrent owner approval"},{db})));
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    await withTenant(db,f.org,async tx=>{
      expect(await tx.ownerPayout.count({where:{state:"APPROVED"}})).toBe(1);expect(await tx.ownerPayout.count({where:{state:"PENDING_APPROVAL",version:2}})).toBe(1);
      expect(await tx.approvalStage.count({where:{state:"PENDING"}})).toBe(1);expect(await tx.auditLog.count({where:{action:"finance.owner_payout.approval_stage_decided"}})).toBe(1);
      expect(await tx.financialTransaction.count()).toBe(1);
    });
  });

  it("cancels a rejected payout and its later stages atomically without recording payment or changing its expected settlement",async()=>{
    const f=await fixture(),receiver=await reviewer(f),ctx=await submissionPolicy(f,{approval:{thresholds:[{key:"reject_owner_payout",requires_approval_from:["manager_owner"]}],
      routing:{manager:{people:[receiver.person.id],roles:[],assigned:false,channels:["in_app"]},owner:{people:[receiver.person.id],roles:[],assigned:false,channels:["in_app"]}}}});
    await unrelatedOwnerOpening(f);
    const draft=await createOwnerPayout(ctx,{...f.input,amount:"500.25",expectedSettlementAt:"2026-11-02T09:00:00Z"},{db});
    const submitted=await submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated rejected payout submission"},{db});
    const stage=await withTenant(db,f.org,tx=>tx.approvalStage.findFirstOrThrow({where:{approvalId:submitted.approvalId!,position:1}}));
    const command={id:stage.approvalId,stageId:stage.id,decision:"REJECTED",reason:"Dedicated payout reviewer rejection"};
    await decideApproval(receiver.actor,command,{db});await decideApproval(receiver.actor,command,{db});
    expect((await getOwnerPayout(ctx,draft.id,{db})).state).toBe("CANCELLED");
    await withTenant(db,f.org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}});expect(row.expectedSettlementAt?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
      expect(await tx.approvalStage.count({where:{approvalId:stage.approvalId,state:"CANCELLED"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.cancelled"}})).toBe(1);expect(await tx.financialTransaction.count()).toBe(2);
    });
    expect(await closing(f)).toBe("10000.00");expect(await closing(f,true)).toBe("777.77");
    const payContext=await paymentGrant(f);
    await expect(payOwnerPayout(payContext,{id:draft.id,expectedVersion:3,paymentReference:"Rejected payout must never pay",reason:"Attempt rejected source payment"},{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    expect(await closing(f)).toBe("10000.00");expect(await closing(f,true)).toBe("777.77");
  });

  it("records concurrent payment retries once and reverses exact postings without changing original journals or owner balances",async()=>{
    const p=await readyForPayment("2020-01-01T09:00:00Z",true);
    const opening=await withTenant(db,p.f.org,tx=>tx.financialTransaction.findFirstOrThrow({include:{postings:{orderBy:{id:"asc"}}}}));
    const unrelated=await unrelatedOwnerOpening(p.f);
    const results=await Promise.all(Array.from({length:4},()=>payOwnerPayout(p.ctx,p.command,{db})));
    expect(results.filter(result=>!result.idempotent)).toHaveLength(1);expect(new Set(results.map(result=>result.transactionId)).size).toBe(1);
    const original=await withTenant(db,p.f.org,tx=>tx.financialTransaction.findUniqueOrThrow({where:{id:results[0].transactionId},include:{postings:{orderBy:{id:"asc"}}}}));
    expect(original.postings).toHaveLength(2);
    expect(original.postings.find(line=>line.side==="DEBIT")).toMatchObject({bucket:"PAYOUT",dimensions:{source:"OWNER_PAYOUT",payout_id:p.draft.id,owner_id:p.f.owner.id,property_id:p.f.property.id}});
    expect(original.postings.find(line=>line.side==="CREDIT")).toMatchObject({bucket:"PAYOUT_PAYMENT",ledgerAccountId:p.f.bank.id});
    expect(original.postings.map(line=>line.amount.toFixed(2))).toEqual(["500.25","500.25"]);
    expect(await closing(p.f)).toBe("9499.75");expect(await closing(p.f,true)).toBe("777.77");
    await expect(payOwnerPayout(p.ctx,{...p.command,paymentReference:"Conflicting bank reference"},{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    const reverse={id:p.draft.id,expectedVersion:results[0].version,reason:"Dedicated exact owner payout reversal"};
    const reversals=await Promise.all(Array.from({length:4},()=>reverseOwnerPayout(p.ctx,reverse,{db})));
    expect(reversals.filter(result=>!result.idempotent)).toHaveLength(1);expect(new Set(reversals.map(result=>result.reversalTransactionId)).size).toBe(1);
    await withTenant(db,p.f.org,async tx=>{
      expect(await tx.financialTransaction.findUniqueOrThrow({where:{id:opening.id},include:{postings:{orderBy:{id:"asc"}}}})).toEqual(opening);
      expect(await tx.financialTransaction.findUniqueOrThrow({where:{id:original.id},include:{postings:{orderBy:{id:"asc"}}}})).toEqual(original);
      expect(await tx.financialTransaction.count()).toBe(4);expect(await tx.posting.count()).toBe(8);
      expect(await tx.financialTransaction.findUniqueOrThrow({where:{id:unrelated.id}})).toEqual(unrelated);
      const balance=await tx.$queryRaw<Array<{amount:string}>>(Prisma.sql`SELECT SUM(CASE WHEN p.side='CREDIT' THEN p.amount ELSE -p.amount END)::text AS amount
        FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE a.code='OWNER_PAYABLE' AND p.dimensions->>'owner_id'=${p.f.owner.id}`);
      expect(Money.of(balance[0].amount,"MAD").toJSON().amount).toBe("10000.00");
      expect(await tx.auditLog.count({where:{resourceId:p.draft.id,action:"finance.owner_payout.paid"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:p.draft.id,action:"finance.owner_payout.reversed"}})).toBe(1);
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:p.draft.id}});expect(row).toMatchObject({state:"CANCELLED",transactionId:original.id,reversalTransactionId:reversals[0].reversalTransactionId});
      expect((await tx.approvalRequest.findFirstOrThrow({where:{payoutId:p.draft.id}})).state).toBe("APPROVED");
    });
    await expect(payOwnerPayout(p.ctx,p.command,{db})).resolves.toMatchObject({state:"CANCELLED",transactionId:original.id,idempotent:true});
    expect(await closing(p.f)).toBe("10000.00");expect(await closing(p.f,true)).toBe("777.77");
  });

  it("keeps reviewer approval, posting permission and independent funding authority separate",async()=>{
    const p=await readyForPayment("2020-01-01T09:00:00Z",true),reviewerContext={organizationId:p.f.org,actorId:p.receiver!.account.id,authContext:p.receiver!.actor.authContext};
    await expect(payOwnerPayout(reviewerContext,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await expect(payOwnerPayout(p.restricted,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await withTenant(db,p.f.org,tx=>tx.roleAssignment.update({where:{id:p.f.bankGrant.id},data:{validTo:new Date("2021-01-01")}}));
    await expect(payOwnerPayout(p.ctx,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    expect(await withTenant(db,p.f.org,tx=>tx.financialTransaction.count())).toBe(1);
    await withTenant(db,p.f.org,tx=>tx.roleAssignment.update({where:{id:p.f.bankGrant.id},data:{validTo:null}}));
    await expect(payOwnerPayout(p.ctx,p.command,{db})).resolves.toMatchObject({state:"PAID",idempotent:false});
  });

  it("rejects scheduling before eligibility, rejects early payment and keeps the exact schedule immutable on retries",async()=>{
    const p=await readyForPayment("2099-01-01T09:00:00Z");
    await expect(payOwnerPayout(p.ctx,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    await expect(scheduleOwnerPayout(p.ctx,p.schedule,{db})).resolves.toMatchObject({state:"SCHEDULED",idempotent:true});
    await expect(scheduleOwnerPayout(p.ctx,{...p.schedule,scheduledFor:"2099-01-02T09:00:00Z"},{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    const f=await fixture(),ctx=await submissionPolicy(f,{payout:{cadence:"OTA_SPLIT_EXPECTED_SETTLEMENT"}}),draft=await createOwnerPayout(ctx,{...f.input,amount:"100.00",expectedSettlementAt:"2099-01-01T09:00:00Z"},{db});
    const submitted=await submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated future eligibility submission"},{db});
    await expect(scheduleOwnerPayout(ctx,{id:draft.id,expectedVersion:submitted.version,scheduledFor:"2099-01-01T08:59:59Z",reason:"Must retain configured earliest eligibility"},{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    expect(await withTenant(db,f.org,tx=>tx.financialTransaction.count())).toBe(1);
  });

  it("refuses payment after approved encrypted recipient details change",async()=>{
    const p=await readyForPayment();
    await withTenant(db,p.f.org,tx=>tx.ownerPayoutMethod.update({where:{id:p.f.method.id},data:{detailsEncrypted:encryptSecret("Different dedicated nonproduction recipient details")}}));
    await expect(payOwnerPayout(p.ctx,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutConfigurationError);
    expect(await withTenant(db,p.f.org,tx=>tx.financialTransaction.count())).toBe(1);
    expect((await getOwnerPayout(p.ctx,p.draft.id,{db})).state).toBe("SCHEDULED");
  });

  it("records one unpaid failure on concurrent retries and prevents a failed job from recording a payment",async()=>{
    const p=await readyForPayment(),command={id:p.draft.id,expectedVersion:p.scheduled.version,reason:"Dedicated bank transfer failed before execution"};
    await unrelatedOwnerOpening(p.f);
    const results=await Promise.all(Array.from({length:3},()=>failOwnerPayout(p.ctx,command,{db})));
    expect(results.filter(row=>!row.idempotent)).toHaveLength(1);
    await expect(payOwnerPayout(p.ctx,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    await expect(failOwnerPayout(p.ctx,{...command,reason:"Conflicting failed transfer explanation"},{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    expect((await getOwnerPayout(p.ctx,p.draft.id,{db})).state).toBe("FAILED");
    expect(await withTenant(db,p.f.org,tx=>tx.financialTransaction.count())).toBe(2);
    expect(await closing(p.f)).toBe("10000.00");expect(await closing(p.f,true)).toBe("777.77");
    expect(await withTenant(db,p.f.org,tx=>tx.auditLog.count({where:{resourceId:p.draft.id,action:"finance.owner_payout.failed"}}))).toBe(1);
  });

  it("cancels an approved unpaid payout while preserving its completed reviewer decisions",async()=>{
    const p=await readyForPayment("2020-01-01T09:00:00Z",true);
    const original=await withTenant(db,p.f.org,tx=>tx.approvalRequest.findFirstOrThrow({where:{payoutId:p.draft.id},include:{financialStages:{include:{recipients:true}}}}));
    const command={id:p.draft.id,expectedVersion:p.scheduled.version,reason:"Dedicated approved unpaid source cancellation"};
    const results=await Promise.all(Array.from({length:3},()=>cancelOwnerPayout(p.ctx,command,{db})));
    expect(results.filter(row=>!row.idempotent)).toHaveLength(1);
    await withTenant(db,p.f.org,async tx=>{
      expect(await tx.approvalRequest.findUniqueOrThrow({where:{id:original.id},include:{financialStages:{include:{recipients:true}}}})).toEqual(original);
      expect(await tx.financialTransaction.count()).toBe(1);expect(await tx.auditLog.count({where:{resourceId:p.draft.id,action:"finance.owner_payout.cancelled"}})).toBe(1);
    });
    await expect(payOwnerPayout(p.ctx,p.command,{db})).rejects.toBeInstanceOf(OwnerPayoutConflictError);
    expect((await getOwnerPayout(p.ctx,p.draft.id,{db})).state).toBe("CANCELLED");
  });

  it("masks native payout audits for operational readers and requires the actual owner scope and independent financial export",async()=>{
    const f=await fixture(),draft=await createOwnerPayout(f.ctx,{...f.input,amount:"500.25"},{db});
    const reader=async(ownerId?:string)=>{
      const person=await withTenant(db,f.org,async tx=>{
        const person=await tx.person.create({data:{organizationId:f.org,displayName:"Dedicated payout audit reader"}}),account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}});
        const grants:Array<{keys:string[];scopeType:"organization"|"owner";scopeId:string|null}>=[{keys:["audit_log:view","audit_log:export"],scopeType:"organization",scopeId:null}];
        if(ownerId)grants.push({keys:["financial_transaction:view"],scopeType:"owner",scopeId:ownerId});
        for(const {keys,scopeType,scopeId}of grants){
          const role=await tx.role.create({data:{organizationId:f.org,key:`payout_audit_${randomUUID()}`,name:"Dedicated scoped payout audit"}});
          const permissions=await tx.permission.findMany({where:{organizationId:f.org,key:{in:[...keys]}}});expect(permissions).toHaveLength(keys.length);
          await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:role.id,permissionId:permission.id}))});
          await tx.roleAssignment.create({data:{organizationId:f.org,userAccountId:account.id,personId:person.id,roleId:role.id,scopeType,scopeId,validFrom:new Date("2020-01-01")}});
        }
        return{person,account};
      });
      return{organizationId:f.org,actorId:person.account.id,personId:person.person.id,authContext:await authContextForAccount(f.org,person.account.id,{db})};
    };
    const auditOnly=await reader(),owner=await reader(f.owner.id),wrong=await reader(f.otherOwner.id),filters={resourceId:draft.id,resourceType:"owner_payout"};
    for(const actor of [auditOnly,wrong]){
      const history=await listAuditHistory(actor,filters,{db});expect(history.rows).toHaveLength(1);expect(history.rows[0].after).toBe(maskedValue);expect(history.rows[0].reason).toBe(maskedValue);
      expect(await exportAuditHistoryCsv(actor,filters,{db})).not.toContain("500.25");
    }
    expect(JSON.stringify(await listAuditHistory(owner,filters,{db}))).toContain("500.25");
    expect(await exportAuditHistoryCsv(owner,filters,{db})).not.toContain("500.25");
    await withTenant(db,f.org,async tx=>{
      const role=await tx.role.create({data:{organizationId:f.org,key:`payout_export_${randomUUID()}`,name:"Dedicated payout source export"}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.org,key:"financial_transaction:export"}});
      await tx.rolePermission.create({data:{organizationId:f.org,roleId:role.id,permissionId:permission.id}});
      await tx.roleAssignment.create({data:{organizationId:f.org,personId:owner.personId,userAccountId:owner.actorId,roleId:role.id,scopeType:"owner",scopeId:f.owner.id,validFrom:new Date("2020-01-01")}});
    });
    const exporter={...owner,authContext:await authContextForAccount(f.org,owner.actorId,{db})};
    expect(await exportAuditHistoryCsv(exporter,filters,{db})).toContain("500.25");
  });

  it("keeps the native workspace scoped to the real owner while hiding independently revoked funding choices",async()=>{
    const f=await fixture(),draft=await createOwnerPayout(f.ctx,{...f.input,amount:"500.25"},{db}),input={ownerId:f.owner.id,propertyId:f.property.id};
    const visible=await getOwnerPayoutWorkspace(f.ctx,input,{db});expect(visible.rows.map(row=>row.id)).toContain(draft.id);
    expect(visible.accounts).toEqual([{id:f.bank.id,name:f.bank.name}]);expect(visible.methods.map(row=>row.id)).toEqual([f.method.id]);
    await expect(getOwnerPayoutWorkspace(f.ctx,{...input,ownerId:f.otherOwner.id},{db})).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.bankGrant.id},data:{validTo:new Date("2021-01-01")}}));
    const ownerOnly=await getOwnerPayoutWorkspace(f.ctx,input,{db});expect(ownerOnly.accounts).toEqual([]);expect(ownerOnly.rows.map(row=>row.id)).toContain(draft.id);
    expect(JSON.stringify(ownerOnly)).not.toContain(f.bank.id);expect(JSON.stringify(ownerOnly)).not.toContain(f.encrypted);
    await withTenant(db,f.org,tx=>tx.property.update({where:{id:f.property.id},data:{archivedAt:new Date()}}));
    expect((await getOwnerPayoutWorkspace(f.ctx,input,{db})).rows.map(row=>row.id)).toContain(draft.id);
    const other=await fixture();await expect(getOwnerPayoutWorkspace(other.ctx,input,{db})).rejects.toBeInstanceOf(OwnerPayoutAccessError);
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.ownerGrant.id},data:{scopeType:"financial_record",scopeId:f.owner.id}}));
    await expect(getOwnerPayoutWorkspace(f.ctx,input,{db})).rejects.toBeInstanceOf(OwnerPayoutAccessError);
  });

  it("requires financial authority before observing a false native payout approval predicate",async()=>{
    const p=await readyForPayment("2020-01-01T09:00:00Z",true),operator=await reviewer(p.f,false);
    await withTenant(db,p.f.org,async tx=>{
      const role=await tx.role.create({data:{organizationId:p.f.org,key:`operational_automation_${randomUUID()}`,name:"Dedicated operational automation author"}});
      const permissions=await tx.permission.findMany({where:{organizationId:p.f.org,OR:[{key:{startsWith:"config_rule:"}},{key:"task:create"}]}});
      await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:p.f.org,roleId:role.id,permissionId:permission.id}))});
      await tx.roleAssignment.create({data:{organizationId:p.f.org,personId:operator.person.id,userAccountId:operator.account.id,roleId:role.id,scopeType:"property",scopeId:p.f.property.id,validFrom:new Date("2020-01-01")}});
      await new ConfigRuleRepository(tx,p.f.org).createVersion({key:"ops.checklists",scopeType:"property",scopeId:p.f.property.id,effectiveFrom:new Date("2020-01-01"),
        value:{checklists:[{key:"payout_qa_inspection",name:{en:"Dedicated inspection",fr:"Inspection",ar:"Inspection"},items:[{key:"inspect",label:{en:"Inspect",fr:"Inspecter",ar:"Inspect"}}]}]},reason:"Dedicated valid operational action"});
    });
    const actor={organizationId:p.f.org,actorId:operator.account.id,personId:operator.person.id,authContext:await authContextForAccount(p.f.org,operator.account.id,{db})};
    const rule=await saveAutomationRule(actor,{key:"payout_approval_privacy",propertyId:p.f.property.id,lifecycle:"ACTIVE",effectiveFrom:new Date("2020-01-01"),reason:"Dedicated native payout privacy regression",
      rule:{name:{en:"Payout privacy",fr:"Confidentialite",ar:"Privacy"},event:"ApprovalRequested",enabled:true,retry:{max_attempts:1,delay_seconds:1},conditions:{path:"approval.status",op:"=",value:"REJECTED"},
        actions:[{key:"inspection",type:"create_task",task_type:"INSPECTION",title:{en:"Inspection",fr:"Inspection",ar:"Inspection"},due:{from:"event.date",offset_days:0},priority:"NORMAL",checklist_template:"payout_qa_inspection"}]}},{db});
    const event=await withTenant(db,p.f.org,async tx=>{
      const approval=await tx.approvalRequest.findFirstOrThrow({where:{payoutId:p.draft.id}});
      return tx.outboxEvent.findFirstOrThrow({where:{type:"ApprovalRequested",payload:{path:["approvalId"],equals:approval.id}}});
    });
    await expect(previewAutomation(actor,{ruleId:rule.id,eventId:event.id},{db})).rejects.toBeInstanceOf(AutomationAccessError);
  });

  it("freezes payout agreement inputs and reuses the real approval under concurrent native event delivery",async()=>{
    const p=await readyForPayment("2020-01-01T09:00:00Z",true);
    const source=await withTenant(db,p.f.org,async tx=>{
      const approval=await tx.approvalRequest.findFirstOrThrow({where:{payoutId:p.draft.id}}),row=await tx.ownerPayout.findUniqueOrThrow({where:{id:p.draft.id}});
      const event=await tx.outboxEvent.findFirstOrThrow({where:{type:"ApprovalRequested",payload:{path:["approvalId"],equals:approval.id}}});
      const snapshot=z.object({payoutRule:z.object({config_rule_id:z.string(),config_rule_version:z.number()})}).parse(row.policySnapshot);
      const permissions=await tx.permission.findMany({where:{organizationId:p.f.org,OR:[{key:{startsWith:"config_rule:"}},{key:"financial_transaction:view"}]}});
      const role=await tx.role.create({data:{organizationId:p.f.org,key:`financial_automation_${randomUUID()}`,name:"Dedicated financial automation author"}});
      await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:p.f.org,roleId:role.id,permissionId:permission.id}))});
      await tx.roleAssignment.create({data:{organizationId:p.f.org,personId:p.f.account.personId,userAccountId:p.f.account.id,roleId:role.id,scopeType:"property",scopeId:p.f.property.id,validFrom:new Date("2020-01-01")}});
      await new ConfigRuleRepository(tx,p.f.org).createVersion({key:"finance.payout_schedule",scopeType:"property",scopeId:p.f.property.id,effectiveFrom:new Date("2020-01-01"),
        value:{cadence:"MONTHLY",schedule:{at:"09:00",month_day:"LAST"},holdback_bps:9900},reason:"Later agreement must not rewrite the submitted payout"});
      return{approval,event,snapshot};
    });
    const actor={...p.ctx,personId:p.f.account.personId,authContext:await authContextForAccount(p.f.org,p.f.account.id,{db})};
    const rule=await saveAutomationRule(actor,{key:"native_payout_approval",propertyId:p.f.property.id,lifecycle:"ACTIVE",effectiveFrom:new Date("2020-01-01"),reason:"Dedicated frozen native payout automation",
      rule:{name:{en:"Native payout approval",fr:"Approbation du versement"},event:"ApprovalRequested",enabled:true,retry:{max_attempts:1,delay_seconds:1},
        conditions:{path:"payout.cadence",op:"=",value:{config:"finance.payout_schedule",path:"cadence"}},
        actions:[{key:"original_review",type:"create_approval_request",title:{en:"Original payout approval",fr:"Approbation originale"},details:{en:"Retain the ordered financial decision",fr:"Conserver la decision financiere"}}]}},{db});
    expect(await previewAutomation(actor,{ruleId:rule.id,eventId:source.event.id},{db})).toMatchObject({matched:true,
      configVersions:[{key:"finance.payout_schedule",id:source.snapshot.payoutRule.config_rule_id,version:source.snapshot.payoutRule.config_rule_version}]});
    const results=await Promise.all(Array.from({length:3},()=>enqueueAutomationEvent(p.f.org,source.event.id,{db})));
    const ids=[...new Set(results.flat())];expect(ids).toHaveLength(1);
    expect(await Promise.all(Array.from({length:3},()=>executeAutomationRun(p.f.org,ids[0],{db})))).toEqual(["SUCCEEDED","SUCCEEDED","SUCCEEDED"]);
    await withTenant(db,p.f.org,async tx=>{
      expect(await tx.approvalRequest.count()).toBe(1);expect(await tx.approvalStage.count({where:{approvalId:source.approval.id}})).toBe(1);
      const run=await tx.automationRun.findUniqueOrThrow({where:{id:ids[0]},include:{attempts:true}});expect(run.attempts).toHaveLength(1);
      expect(JSON.stringify(run.outputs)).toContain(source.approval.id);expect(JSON.stringify(run.inputs)).not.toContain(p.f.encrypted);
      expect(await tx.financialTransaction.count()).toBe(1);
    });
    const paid=await Promise.all(Array.from({length:3},()=>payOwnerPayout(p.ctx,p.command,{db})));expect(paid.filter(row=>!row.idempotent)).toHaveLength(1);
    const events=await withTenant(db,p.f.org,tx=>tx.outboxEvent.findMany({where:{type:{in:["PayoutScheduled","PayoutPaid"]}}}));
    expect(events.map(row=>row.type).sort()).toEqual(["PayoutPaid","PayoutScheduled"]);
    await withTenant(db,p.f.org,async tx=>{
      const context=await new AutomationRepository(tx,p.f.org).context(events.find(row=>row.type==="PayoutPaid")!.id);
      expect(context.payout?.resource).toMatchObject({id:p.draft.id,ownerId:p.f.owner.id,amount:"500.25",dataClass:"financial"});
      expect(context.evaluation.fields.payout).toMatchObject({amount:"500.25",cadence:"OTA_SPLIT_EXPECTED_SETTLEMENT",status:"PAID"});
    });
    const other=await fixture();await expect(withTenant(db,other.org,tx=>new AutomationRepository(tx,other.org).context(source.event.id))).rejects.toThrow("automation_source_missing");
  });

  it("denies an operational configurator replay of a failed financial payout job under its privileged author",async()=>{
    const p=await readyForPayment("2020-01-01T09:00:00Z",true),operator=await reviewer(p.f,false);
    await withTenant(db,p.f.org,async tx=>{
      for(const [account,financial]of [[p.f.account,true],[operator.account,false]] as const){
        const role=await tx.role.create({data:{organizationId:p.f.org,key:`payout_replay_${randomUUID()}`,name:"Dedicated replay authority"}});
        const permissions=await tx.permission.findMany({where:{organizationId:p.f.org,OR:[{key:{startsWith:"config_rule:"}},...(financial?[{key:"financial_transaction:view"}]:[])]}});
        await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:p.f.org,roleId:role.id,permissionId:permission.id}))});
        await tx.roleAssignment.create({data:{organizationId:p.f.org,userAccountId:account.id,personId:account.personId,roleId:role.id,scopeType:"property",scopeId:p.f.property.id,validFrom:new Date("2020-01-01")}});
      }
    });
    const actor={...p.ctx,personId:p.f.account.personId,authContext:await authContextForAccount(p.f.org,p.f.account.id,{db})};
    await saveAutomationRule(actor,{key:"payout_replay_authority",propertyId:p.f.property.id,lifecycle:"ACTIVE",effectiveFrom:new Date("2020-01-01"),reason:"Dedicated financial replay authority regression",
      rule:{name:{en:"Payout review",fr:"Approbation du versement"},event:"PayoutScheduled",enabled:true,retry:{max_attempts:1,delay_seconds:1},conditions:{all:[]},
        actions:[{key:"original_review",type:"create_approval_request",title:{en:"Original payout review",fr:"Approbation originale"},details:{en:"Retain original approval",fr:"Conserver approbation"}}]}},{db});
    const event=await withTenant(db,p.f.org,tx=>tx.outboxEvent.findFirstOrThrow({where:{idempotencyKey:`payout:${p.draft.id}:PayoutScheduled`}}));
    const [id]=await enqueueAutomationEvent(p.f.org,event.id,{db});
    await withTenant(db,p.f.org,tx=>tx.roleAssignment.update({where:{id:p.f.ownerGrant.id},data:{validTo:new Date("2021-01-01")}}));
    expect(await executeAutomationRun(p.f.org,id,{db})).toBe("FAILED");
    await withTenant(db,p.f.org,tx=>tx.roleAssignment.update({where:{id:p.f.ownerGrant.id},data:{validTo:null}}));
    const operational={organizationId:p.f.org,actorId:operator.account.id,personId:operator.person.id,authContext:await authContextForAccount(p.f.org,operator.account.id,{db})};
    await expect(replayAutomation(operational,{runId:id,reason:"Operational configuration is not financial authority"},{db})).rejects.toBeInstanceOf(AutomationAccessError);
    await withTenant(db,p.f.org,async tx=>{
      expect((await tx.automationRun.findUniqueOrThrow({where:{id}})).status).toBe("FAILED");
      expect(await tx.auditLog.count({where:{resourceId:id,action:"automation.run.replayed"}})).toBe(0);expect(await tx.financialTransaction.count()).toBe(1);
    });
    expect(await replayAutomation(actor,{runId:id,reason:"Authorized financial source replay"},{db})).toBe("PENDING");
    expect(await Promise.all(Array.from({length:3},()=>executeAutomationRun(p.f.org,id,{db})))).toEqual(["SUCCEEDED","SUCCEEDED","SUCCEEDED"]);
    await expect(replayAutomation(operational,{runId:id,reason:"Operational completed-result observation must remain denied"},{db})).rejects.toBeInstanceOf(AutomationAccessError);
    await withTenant(db,p.f.org,async tx=>{expect(await tx.approvalRequest.count()).toBe(1);expect(await tx.financialTransaction.count()).toBe(1);});
  });

  it("rechecks stored permissions after a payment waits for the shared accounting-period lock",async()=>{
    const p=await readyForPayment();let release!:()=>void,acquired!:(pid:number)=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<number>(resolve=>{acquired=resolve;});
    const blocker=withTenant(db,p.f.org,async tx=>{
      await new AccountingPeriodRepository(tx,p.f.org).lock();const [row]=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;acquired(row.pid);await gate;
    });
    const pid=await ready,attempt=payOwnerPayout(p.ctx,p.command,{db}).then(value=>({value,error:null}),(error:unknown)=>({value:null,error}));
    try{
      await expect.poll(()=>withTenant(db,p.f.org,async tx=>{
        const [row]=await tx.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND ${pid}::int=ANY(pg_blocking_pids(pid))) AS waiting`;return row.waiting;
      }),{timeout:10000}).toBe(true);
      await withTenant(db,p.f.org,tx=>tx.$executeRaw`UPDATE role_assignment SET valid_to=clock_timestamp() WHERE organization_id=${p.f.org}::uuid AND id=${p.f.ownerGrant.id}::uuid`);
    }finally{release();await blocker;}
    const result=await attempt;expect(result.error).toBeInstanceOf(OwnerPayoutAccessError);
    await withTenant(db,p.f.org,async tx=>{
      expect(await tx.financialTransaction.count()).toBe(1);expect((await tx.ownerPayout.findUniqueOrThrow({where:{id:p.draft.id}})).state).toBe("SCHEDULED");
      expect(await tx.auditLog.count({where:{resourceId:p.draft.id,action:"finance.owner_payout.paid"}})).toBe(0);
    });
  });
});
