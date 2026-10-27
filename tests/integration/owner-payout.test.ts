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

describe("native owner payout persistence on real PostgreSQL", () => {
  beforeAll(async () => {
    if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Dedicated local PostgreSQL is required");
    execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
    admin = new PrismaClient({ datasourceUrl: url });await provisionIntegrationRole(admin, "alvillas_ops_tests");
    const scoped = new URL(url);scoped.username = "alvillas_ops_tests";scoped.password = "alvillas_ops_tests";
    db = new PrismaClient({ datasourceUrl: scoped.toString() });
  });
  afterAll(async () => { await db?.$disconnect();await admin?.$disconnect(); });

  it("stores exact draft cents and attributed reads without creating a payment or disclosing bank secrets", async () => {
    const f = await fixture(), created = await createOwnerPayout(f.ctx, f.input, { db });
    const view = await getOwnerPayout(f.ctx, created.id, { db });
    expect(view).toMatchObject({ amount: f.input.amount, currency: "MAD", state: "DRAFT", version: 1, paidAt: null });
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
    const draft=await createOwnerPayout(ctx,{...f.input,amount:"500.25",expectedSettlementAt:"2026-11-02T09:00:00Z"},{db});
    const submitted=await submitOwnerPayout(ctx,{id:draft.id,expectedVersion:1,reason:"Dedicated rejected payout submission"},{db});
    const stage=await withTenant(db,f.org,tx=>tx.approvalStage.findFirstOrThrow({where:{approvalId:submitted.approvalId!,position:1}}));
    const command={id:stage.approvalId,stageId:stage.id,decision:"REJECTED",reason:"Dedicated payout reviewer rejection"};
    await decideApproval(receiver.actor,command,{db});await decideApproval(receiver.actor,command,{db});
    expect((await getOwnerPayout(ctx,draft.id,{db})).state).toBe("CANCELLED");
    await withTenant(db,f.org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id:draft.id}});expect(row.expectedSettlementAt?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
      expect(await tx.approvalStage.count({where:{approvalId:stage.approvalId,state:"CANCELLED"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:draft.id,action:"finance.owner_payout.cancelled"}})).toBe(1);expect(await tx.financialTransaction.count()).toBe(1);
    });
  });
});
