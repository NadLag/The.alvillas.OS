import { dashboardAccess } from "@/platform/command-center/dashboard";
import { searchCommandCenter } from "@/platform/command-center/search";
import { operationManagement } from "@/modules/reservations/application/operation-management";
import { getCommandFinance } from "@/modules/finance/application/command-center-finance";
import { commandExceptionsPage } from "@/platform/command-center/exceptions";
import { getCommandCenterToday } from "@/modules/reservations/application/command-center-today";
import { tickScheduledReports } from "@/modules/finance/application/scheduled-report-job";
import { ScheduledReportRepository } from "@/modules/finance/infrastructure/scheduled-report-repository";
import { notificationDestination } from "@/platform/notifications/notification";
import { refreshKpiCalendar } from "@/modules/finance/application/kpi-materialization-job";
import { KpiMaterializationRepository } from "@/modules/finance/infrastructure/kpi-materialization-repository";
import { calendarDateAt } from "@/i18n/format";
import { getKpiReport } from "@/modules/finance/application/kpi-report";
import { getTeamPerformanceReport } from "@/modules/finance/application/team-performance-report";
import { teamReportMetrics } from "@/modules/finance/domain/performance-report";
import { exportCompanyPerformanceReport, getCompanyPerformanceReport } from "@/modules/finance/application/company-performance-report";
import { companyReportMetrics } from "@/modules/finance/domain/performance-report";
import { getPropertyPerformanceReport, exportPropertyPerformanceReport } from "@/modules/finance/application/property-performance-report";
import { PerformanceReportAccessError, propertyReportMetrics } from "@/modules/finance/domain/performance-report";
import { performanceReportFile } from "@/modules/finance/application/performance-report-file";
import { Money } from "@/platform/money/money";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {createExpenseDraft,submitExpense} from "@/modules/finance/application/expense-service";
import {postExpense,voidExpense} from "@/modules/finance/application/expense-posting-service";
import {getPropertyFinance} from "@/modules/finance/application/property-finance-service";
import {PropertyFinanceAccessError,PropertyFinanceSourceChangedError} from "@/modules/finance/domain/property-finance";
import {listAuditHistory,exportAuditHistoryCsv} from "@/modules/audit/application/audit-service";
import {maskedValue} from "@/platform/authz/present";
import * as auditWriter from "@/platform/audit/audit-writer";
import {provisionIntegrationRole} from "./support/database-role";
import {recordFieldCashInTransaction} from "@/platform/ledger/field-cash-service";
import {cashCollectionRevision} from "@/modules/finance/domain/cash-custody";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
const keys=["property:view","property_finance:view","financial_transaction:view","company_ledger:view","owner_statement:view","expense:view","supplier_invoice:view","employee_payable:view","staff_compensation:view","wallet:view","cash_collection:view","owner:view","supplier:view","team_member:view","expense:create","expense:edit","expense:pay","expense:void","financial_transaction:create","financial_transaction:void","financial_transaction:override","audit_log:view","audit_log:export"];
beforeAll(async()=>{const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated actual property finance acceptance database required");execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const restricted=new URL(url!);restricted.username="alvillas_ops_tests";restricted.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:restricted.toString()});});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});
async function fixture(){
 const org=randomUUID();await admin.organization.create({data:{id:org,name:"Actual independent property finance acceptance",baseCurrency:"MAD"}});await ensureStandardIdentitySetup(org,{db});
 const facts=await withTenant(db,org,async tx=>{
  for(const code of["MAD","EUR"])await tx.currency.upsert({where:{code},update:{},create:{code,name:code,minorUnit:2}});
  const person=await tx.person.create({data:{organizationId:org,displayName:"Actual property financial operator"}}),account=await tx.userAccount.create({data:{organizationId:org,personId:person.id}}),role=await tx.role.create({data:{organizationId:org,key:"actual_property_finance",name:"Actual independently granted property financial authority"}}),permissions=await tx.permission.findMany({where:{organizationId:org,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:org,roleId:role.id,permissionId:permission.id}))});const grant=await tx.roleAssignment.create({data:{organizationId:org,roleId:role.id,userAccountId:account.id,personId:person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
  const property=await tx.property.create({data:{organizationId:org,name:"Actual mortgage property",addressLine1:"Actual test property",city:"Marrakech",timezone:"UTC",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}}),owner=await tx.owner.create({data:{organizationId:org,displayName:"Actual property financial owner"}});await tx.propertyOwner.create({data:{organizationId:org,propertyId:property.id,ownerId:owner.id}});
  const bank=await new FinanceRepository(tx,org).ensureLedgerAccount({code:"ACTUAL_PROPERTY_BANK",name:"Actual property operating bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),rules=new ConfigRuleRepository(tx,org);
  for(const[key,value]of[["finance.expense_treatment",{default_treatment:"OWNER_PAID"}],["finance.approval_thresholds",{thresholds:[]}],["finance.accounting_periods",{timezone:"UTC",allow_early_close:false,max_reopen_seconds:60}]]as const)await rules.createVersion({key,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:account.id,value,reason:"Explicit original configured property accounting treatment"});
  const now=await new FinanceRepository(tx,org).clock();return{person,account,role,grant,property,bank,on:now.toISOString().slice(0,10)};
 });const ctx={organizationId:org,actorId:facts.account.id,authContext:{...await authContextForAccount(org,facts.account.id,{db}),personId:facts.person.id}};return{org,...facts,ctx};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function mortgage(f:Fixture,amount="0.07",currency="MAD",on=f.on){const draft=await createExpenseDraft(f.ctx,{propertyId:f.property.id,amount,currency,category:"mortgage",purpose:"Actual property mortgage under configured accounting treatment",occurredOn:on,fundingAccountId:f.bank.id,emergency:false,idempotencyKey:randomUUID(),reason:"Actual native mortgage source without invented principal or interest"},{db}),submitted=await submitExpense(f.ctx,{id:draft.id,expectedVersion:1,reason:"Submit the actual configured property mortgage cost"},{db});return postExpense(f.ctx,{id:draft.id,expectedVersion:submitted.version,reason:"Post actual approved property mortgage expense"},{db});}
const query=(f:Fixture)=>({propertyId:f.property.id,fromOn:f.on,toOn:f.on,currency:"MAD"});
const financial=(f:Fixture)=>withTenant(db,f.org,tx=>tx.$queryRaw<Array<{kind:string;id:string;xmin:string;body:unknown}>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);

async function grantPerformanceReports(f: Fixture) {
   await withTenant(db, f.org, async tx => {
     const keys = ["report:view", "report:export", "reservation:view", "task:view", "property_finance:export", "financial_transaction:export",
       "company_ledger:export", "owner_statement:export", "expense:export", "supplier_invoice:export", "employee_payable:export",
       "staff_compensation:export", "wallet:export", "cash_collection:export"];
     const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } });
     expect(permissions).toHaveLength(keys.length);
     await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })) });
     await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.accountant_exports", scopeType: "organization",
       effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id, reason: "Authorize original report file generation",
       value: { source: "ORIGINAL_POSTED_FINANCIAL_SOURCES", reports: ["TRANSACTIONS"], formats: ["CSV", "EXCEL", "PDF"],
         classifications: {}, capacity: { CSV: 100, EXCEL: 100, PDF: 100 }, rate_limit: { requests: 20, window_seconds: 60 } } });
   });
   return { ...f.ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
}

describe("actual property-attributed finance and immutable mortgage history",()=>{
 it("derives property performance from exact sealed postings and original stay dates", async () => {
   const f = await fixture();
   const ctx = await grantPerformanceReports(f);
   await withTenant(db, f.org, async tx => {
     const finance = new FinanceRepository(tx, f.org);
     const claim = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Original claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
     const dimensions = { property_id: f.property.id };
     for (const [currency, amount] of [["MAD", "9007199254740993.07"], ["EUR", "71.13"]]) {
       await finance.createFinancialTransaction({ reference: randomUUID(), description: "Original posted lodging revenue", occurredAt: new Date("2026-03-08T09:00:00Z"),
         idempotencyKey: randomUUID(), createdBy: f.account.id, postings: [
           { ledgerAccountId: f.bank.id, side: "DEBIT", amount: Money.of(amount, currency), bucket: "OWNER_REVENUE", dimensions },
           { ledgerAccountId: claim.id, side: "CREDIT", amount: Money.of(amount, currency), bucket: "OWNER_REVENUE", dimensions }
         ] });
     }
     await tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: randomUUID(), source: "DIRECT",
       status: "CHECKED_OUT", guestName: "Private guest", checkIn: new Date("2026-03-08"), checkOut: new Date("2026-03-09"),
       nights: 1, idempotencyKey: randomUUID() } });
     await tx.calendarBlock.create({ data: { organizationId: f.org, propertyId: f.property.id, kind: "MAINTENANCE", source: "MANUAL",
       checkIn: new Date("2026-03-09"), checkOut: new Date("2026-03-10"), idempotencyKey: randomUUID() } });
   });
   const filter = { propertyId: f.property.id, fromOn: "2026-03-08", toOn: "2026-03-10", currency: "MAD" };
   const original = await financial(f), report = await getPropertyPerformanceReport(ctx, filter, { db });
   expect(report).toMatchObject({ occupied: "1", available: "2", blocked: "1", conflicts: "0", occupancy: "50.00" });
   expect(report.adr?.toJSON().amount).toBe("9007199254740993.07");
   expect(report.revpar?.toJSON().amount).toBe("4503599627370496.54");
   expect(report.ownerResult.toJSON().amount).toBe("9007199254740993.07");
   await withTenant(db, f.org, async tx => {
     const keys = ["inventory_item:view", "inventory_location:view", "inventory_movement:view", "issue:view",
       "role:view", "service_allocation:view"];
     const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } });
     expect(permissions).toHaveLength(keys.length);
     await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })) });
   });
   const kpiActor = { ...ctx, authContext: await authContextForAccount(f.org, f.account.id, { db }) };
   const kpis = await getKpiReport(kpiActor, filter, { db });
   expect(kpis.metrics.find(row => row.key === "occupancy")?.count).toBe("50.00%");
   expect(kpis.metrics.find(row => row.key === "adr")?.amount?.toJSON().amount).toBe("9007199254740993.07");
   expect(kpis.metrics.find(row => row.key === "kpiOwnerCash")?.amount).toBeNull();
   const quarter = await getKpiReport(kpiActor, { propertyId: f.property.id, currency: "EUR", period: "2026-Q1" }, { db });
   expect(quarter).toMatchObject({ fromOn: "2026-01-01", toOn: "2026-03-31" });
   expect(quarter.metrics.find(row => row.key === "adr")?.amount?.toJSON().amount).toBe("71.13");
   await expect(getKpiReport(kpiActor, { ...filter, ownerId: randomUUID() }, { db })).rejects.toBeInstanceOf(PerformanceReportAccessError);
   const eur = await getPropertyPerformanceReport(ctx, { ...filter, currency: "EUR" }, { db });
   expect(eur.adr?.toJSON().amount).toBe("71.13");
   for (const format of ["CSV", "EXCEL", "PDF"] as const) {
     const bytes = await exportPropertyPerformanceReport(ctx, filter, {
       format, render: (original, policy) => {
         const report = propertyReportMetrics(original);
         return performanceReportFile({ ...original, organizationId: f.org, kind: "PROPERTY_PERFORMANCE",
           metrics: [...report.financial, ...report.occupancy] }, format, "en", policy, "propertyTitle");
       }
     }, { db });
     if (format === "CSV") expect(new TextDecoder().decode(bytes)).toContain("9007199254740993.07");
     else expect(new TextDecoder().decode(bytes.slice(0, 5))).toMatch(format === "PDF" ? /^%PDF-/u : /^PK/u);
   }
   const unrelated = await fixture();
   await expect(getPropertyPerformanceReport(unrelated.ctx, filter, { db })).rejects.toBeInstanceOf(PerformanceReportAccessError);
   expect(await financial(f)).toEqual(original);
 });

 it("refreshes and invalidates the materialized KPI calendar at the original tenant revision", async () => {
   const f = await fixture(), another = await fixture();
   const today = calendarDateAt(new Date(), "UTC"), fromOn = today.slice(0, 7) + "-01";
   const range = { fromOn, toOn: today, timezone: "UTC" };
   const cache = (organizationId: string) => withTenant(db, organizationId,
     tx => new KpiMaterializationRepository(tx, organizationId).lookup(range));
   await withTenant(db, f.org, async tx => {
     await tx.property.update({ where: { id: f.property.id }, data: { status: "ACTIVE" } });
     await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.kpi_refresh", scopeType: "organization",
       createdBy: f.account.id, effectiveFrom: new Date("2020-01-01"), reason: "Configured materialized calendar window",
       value: { periods: ["CURRENT_MONTH"], refresh_minutes: 60 } });
   });
   expect(await refreshKpiCalendar(f.org, db)).toBe(1);
   expect(await refreshKpiCalendar(f.org, db)).toBe(0);
   expect(await cache(f.org)).toMatchObject([{ propertyId: f.property.id, occupied: "0" }]);
   expect(await cache(another.org)).toBeNull();
   await withTenant(db, f.org, tx => tx.property.update({ where: { id: f.property.id }, data: { name: "Updated native property name" } }));
   expect(await cache(f.org)).toBeNull();
   expect(await refreshKpiCalendar(f.org, db)).toBe(1);
   expect(await cache(f.org)).toMatchObject([{ propertyName: "Updated native property name" }]);
 });

 it("publishes one authorized scheduled report with immutable period and current recipient access", async () => {
   const f = await fixture(), other = await fixture();
   await grantPerformanceReports(f);
   await withTenant(db, f.org, async tx => {
     const permission = await tx.permission.findFirstOrThrow({ where: { organizationId: f.org, key: "config_rule:configure" } });
     await tx.rolePermission.create({ data: { organizationId: f.org, roleId: f.role.id, permissionId: permission.id } });
     await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.report_schedules", scopeType: "organization",
       createdBy: f.account.id, effectiveFrom: new Date("2020-01-01"), reason: "Send authorized reports on the configured calendar",
       value: { schedules: [{ id: randomUUID(), kind: "COMPANY", recipients: [f.account.id, other.account.id], starts_on: "2020-01-01",
         time: "00:00", occurrence: { frequency: "MONTHLY", day: 1 }, channels: ["in_app"] }] } });
   });
   const [first, second] = await Promise.all([tickScheduledReports(f.org, { db }), tickScheduledReports(f.org, { db })]);
   expect(first.scheduled + second.scheduled).toBe(1);
   const result = await withTenant(db, f.org, async tx => {
     const item = await tx.notification.findFirstOrThrow({ where: { organizationId: f.org, kind: "report_ready", recipientId: f.account.id } });
     const [run] = await new ScheduledReportRepository(tx, f.org).targets([item.targetId], f.account.id);
     expect(await tx.notification.count({ where: { organizationId: f.org, kind: "report_ready" } })).toBe(1);
     return { id: item.targetId, scope: run.target };
   });
   const input = { kind: "report_ready", recipientId: f.account.id, targetId: result.id } as const;
   const actor = await authContextForAccount(f.org, f.account.id, { db });
   expect(notificationDestination(actor, input, result.scope, "ar")).toBe(
     "/ar/app/reports/company?fromOn="+result.scope.reportRun.fromOn+"&toOn="+result.scope.reportRun.toOn+"&currency=MAD");
   expect(await withTenant(db, other.org, tx => new ScheduledReportRepository(tx, other.org).targets([result.id], other.account.id))).toEqual([]);
   await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
   expect(notificationDestination(await authContextForAccount(f.org, f.account.id, { db }), input, result.scope, "en")).toBeNull();
 });

 it("shows local-day turnover and due work only from authorized native records", async () => {
   const f = await fixture(), other = await fixture();
   const authContext = await grantPerformanceReports(f);
   await withTenant(db, f.org, async tx => {
     await tx.property.update({ where: { id: f.property.id }, data: { timezone: "Pacific/Kiritimati" } });
     const stay = { organizationId: f.org, propertyId: f.property.id, source: "DIRECT", guestName: "Private arrival name", nights: 1 };
     await tx.reservation.create({ data: { ...stay, reference: "TODAY-OUT", checkIn: new Date("2026-03-08"),
       checkOut: new Date("2026-03-09"), status: "CHECKED_OUT", idempotencyKey: randomUUID() } });
     await tx.reservation.create({ data: { ...stay, reference: "TODAY-IN", checkIn: new Date("2026-03-09"),
       checkOut: new Date("2026-03-10"), status: "CONFIRMED", idempotencyKey: randomUUID() } });
     const task = { organizationId: f.org, propertyId: f.property.id, type: "TRANSFER",
       titleTranslations: { en: "Actual transfer", fr: "Transfert réel" } };
     await tx.operationTask.create({ data: { ...task, dueDate: new Date("2026-03-09"), state: "PLANNED", idempotencyKey: randomUUID() } });
     await tx.operationTask.create({ data: { ...task, dueDate: new Date("2026-03-08"), state: "PLANNED", idempotencyKey: randomUUID() } });
   });
   const now = new Date("2026-03-08T12:00:00Z");
   const actor = { ...authContext, personId: f.person.id };
   const report = await getCommandCenterToday(actor, { db, now });
   expect(report).toMatchObject({ arrivals: [{ reference: "TODAY-IN", date: "2026-03-09" }],
     departures: [{ reference: "TODAY-OUT" }], turnovers: [{ propertyId: f.property.id }], incomplete: [{ date: "2026-03-09" }] });
   expect(JSON.stringify(report)).not.toContain("Private arrival name");
   const work = await operationManagement(actor, { propertyId: f.property.id, view: "LIST", from: "2026-03-09", until: "2026-03-09" },
     { db, now, includeWorkload: true });
   expect(work.workload).toEqual({ unassigned: 1, workers: [] });
   expect(await getCommandCenterToday({ ...other.ctx, personId: other.person.id }, { db, now })).toBeNull();
   await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { validTo: new Date("2026-02-28") } }));
   expect(await getCommandCenterToday(actor, { db, now })).toBeNull();
 });

 it("reads only open authorized booking conflicts and failed syncs in Command Center", async () => {
   const f = await fixture(), other = await fixture();
   const actor = { ...await grantPerformanceReports(f), personId: f.person.id };
   await withTenant(db, f.org, async tx => {
     const source = { organizationId: f.org, propertyId: f.property.id, details: { private: "Private feed URL" } };
     await tx.reservationException.createMany({ data: [
       { ...source, kind: "DOUBLE_BOOKING", key: randomUUID() },
       { ...source, kind: "FEED_SYNC_FAILED", key: randomUUID() },
       { ...source, kind: "DOUBLE_BOOKING", status: "RESOLVED", key: randomUUID() }
     ] });
   });
   const conflicts = await commandExceptionsPage(actor, { kind: "conflicts" }, db);
   expect(conflicts).toMatchObject({ state: "ready", items: [{ kind: "DOUBLE_BOOKING", propertyName: f.property.name }] });
   expect(JSON.stringify(conflicts)).not.toContain("Private feed URL");
   expect(await commandExceptionsPage(actor, { kind: "sync" }, db)).toMatchObject({ state: "ready", items: [{ kind: "FEED_SYNC_FAILED" }] });
   expect(await commandExceptionsPage({ ...other.ctx, personId: other.person.id }, { kind: "conflicts" }, db)).toEqual({ state: "denied" });
   await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
   expect(await commandExceptionsPage(actor, { kind: "conflicts" }, db)).toEqual({ state: "denied" });
 });

 it("finds original records through full-text and trigram search under current tenant grants", async () => {
   const f = await fixture(), other = await fixture(), actor = await grantPerformanceReports(f);
   const fullText = await searchCommandCenter(actor, { q: "Actual property" }, "en", db);
   expect(fullText.find(group => group.kind === "property")?.items).toEqual([
     { id: f.property.id, title: f.property.name, href: "/properties/" + f.property.id }
   ]);
   const typo = await searchCommandCenter(actor, { q: "Actual morgtage property", kind: "property" }, "fr", db);
   expect(typo[0].items.map(item => item.id)).toEqual([f.property.id]);
   const foreign = await searchCommandCenter(other.ctx, { q: "Actual property", kind: "property" }, "ar", db);
   expect(foreign[0].items.map(item => item.id)).toEqual([other.property.id]);
   await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.grant.id }, data: { archivedAt: new Date() } }));
   expect(await searchCommandCenter(actor, { q: "Actual property", kind: "property" }, "en", db)).toEqual([]);
 });

 it("separates company profit and portfolio performance from location and owner claim balances", async () => {
   const f = await fixture(), ctx = await grantPerformanceReports(f);
   await withTenant(db, f.org, async tx => {
     await tx.property.update({ where: { id: f.property.id }, data: { status: "ACTIVE" } });
     const finance = new FinanceRepository(tx, f.org);
     const company = (code: string, normalSide: "CREDIT" | "DEBIT") =>
       finance.ensureLedgerAccount({ code, name: code, normalSide, accountType: "ALVILLAS_OWN" });
     const location = (code: string) => finance.ensureLedgerAccount({ code, name: code, normalSide: "DEBIT", accountType: "ASSET_LOCATION" });
     const [commission, expense, bank, cash, custody, clearing, claim] = await Promise.all([
       company("ALVILLAS_COMMISSION_REVENUE", "CREDIT"),
       company("ALVILLAS_EXPENSE", "DEBIT"), location("BANK_MAIN"), location("CASH_MAIN"), location("CASH_CUSTODY_PERSON"),
       location("OTA_CLEARING_BOOKING"), finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Private owner payable",
         normalSide: "CREDIT", accountType: "CLAIM_OWNERSHIP" })
     ]);
     const record = async (debit: string, credit: string, amount: string, propertyId?: string, currency = "MAD") => {
       const value = Money.of(amount, currency), dimensions = propertyId ? { property_id: propertyId } : {};
       await finance.createFinancialTransaction({ reference: randomUUID(), description: "Native source of company performance",
         idempotencyKey: randomUUID(), occurredAt: new Date("2026-03-08T12:00:00Z"), createdBy: f.account.id, postings: [
           { ledgerAccountId: debit, side: "DEBIT", amount: value, bucket: "REPORT_TEST", dimensions },
           { ledgerAccountId: credit, side: "CREDIT", amount: value, bucket: "REPORT_TEST", dimensions }
         ] });
     };
     await record(bank.id, commission.id, "1000.01", f.property.id);
     await record(cash.id, bank.id, "20.00");
     await record(expense.id, bank.id, "250.11", f.property.id);
     await record(expense.id, bank.id, "9.99");
     await record(bank.id, claim.id, "777.77", f.property.id);
     await record(custody.id, claim.id, "100.00", f.property.id);
     await record(clearing.id, claim.id, "200.00", f.property.id);
     await record(bank.id, commission.id, "55.25", f.property.id, "EUR");
     await tx.reservation.create({ data: { organizationId: f.org, propertyId: f.property.id, reference: randomUUID(),
       source: "DIRECT", status: "CHECKED_OUT", guestName: "Private individual", checkIn: new Date("2026-03-08"), checkOut: new Date("2026-03-09"),
       nights: 1, idempotencyKey: randomUUID() } });
   });
   const filter = { fromOn: "2026-03-08", toOn: "2026-03-09", currency: "MAD" };
   const original = await financial(f), report = await getCompanyPerformanceReport(ctx, filter, { db });
   expect(report.revenue.toJSON().amount).toBe("1000.01");
   expect(report.profit.toJSON().amount).toBe("739.91");
   expect(report.cashPosition.toJSON().amount).toBe("1517.68");
   expect(report.outsidePortfolio.toJSON().amount).toBe("-9.99");
   const asRole = (roleKey: string) => ({ ...ctx.authContext, assignments: ctx.authContext.assignments?.map(grant => ({ ...grant, roleKey })) });
   expect(dashboardAccess(asRole("finance")).profiles).toEqual(["finance"]);
   expect(dashboardAccess(asRole("operations_manager")).profiles).toEqual(["manager", "operations"]);
   const dashboard = await getCommandFinance(ctx, filter, { db });
   expect([dashboard.revenue, dashboard.expenses, dashboard.cash, dashboard.ownerPayable, dashboard.companyBalance]
     .map(value => value.toJSON().amount)).toEqual(["1000.01", "260.10", "1517.68", "1077.77", "739.91"]);
   const euroDashboard = await getCommandFinance(ctx, { ...filter, currency: "EUR" }, { db });
   expect(euroDashboard.ownerPayable.toJSON()).toEqual({ amount: "0.00", currency: "EUR" });
   await expect(getCommandFinance(f.ctx, filter, { db })).rejects.toBeInstanceOf(PerformanceReportAccessError);
   expect(report.margin).toBe("73.99");
   expect(report.properties[0]).toMatchObject({ propertyId: f.property.id, occupied: "1", available: "2", occupancy: "50.00" });
   const eur = await getCompanyPerformanceReport(ctx, { ...filter, currency: "EUR" }, { db });
   expect(eur.revenue.toJSON().amount).toBe("55.25");
   expect(JSON.stringify(report)).not.toMatch(/BANK_MAIN|Private individual|Private owner payable/u);
   const bytes = await exportCompanyPerformanceReport(ctx, filter, { format: "CSV", render: (original, policy) => {
     const metrics = companyReportMetrics(original);
     return performanceReportFile({ ...original, organizationId: f.org, kind: "COMPANY_PERFORMANCE", propertyId: null,
       metrics: [...metrics.financial, ...metrics.cash] }, "CSV", "en", policy, "companyTitle");
   } }, { db });
   expect(new TextDecoder().decode(bytes)).toContain("1517.68");
   await expect(getCompanyPerformanceReport(f.ctx, filter, { db })).rejects.toBeInstanceOf(PerformanceReportAccessError);
   expect(await financial(f)).toEqual(original);
 });

 it("reports actual workload and performers with immutable currency-separated wallet activity", async () => {
   const f = await fixture(), ctx = await grantPerformanceReports(f);
   const performer = await withTenant(db, f.org, async tx => {
     const performer = await tx.person.create({ data: { organizationId: f.org, displayName: "Native recorded performer" } });
     const task = { organizationId: f.org, propertyId: f.property.id, type: "TRANSFER", dueDate: new Date("2026-03-08"),
       assignedToPersonId: f.person.id, titleTranslations: { en: "Original operational job", fr: "Intervention d?origine" } };
     await tx.operationTask.create({ data: { ...task, state: "ASSIGNED", idempotencyKey: randomUUID() } });
     await tx.operationTask.create({ data: { ...task, state: "COMPLETED", idempotencyKey: randomUUID(),
       completedByPersonId: performer.id, completedAt: new Date("2026-03-08T13:00:00Z") } });
     await tx.operationTask.create({ data: { ...task, state: "CANCELLED", idempotencyKey: randomUUID() } });
     const finance = new FinanceRepository(tx, f.org);
     const wallet = await finance.ensureLedgerAccount({ code: "WALLET_TEAM_REPORT", name: "Internal funding account",
       accountType: "STAFF_WALLET", normalSide: "DEBIT" });
     await tx.teamWallet.create({ data: { organizationId: f.org, personId: performer.id, ledgerAccountId: wallet.id, createdBy: f.account.id } });
     for (const [currency, amount] of [["MAD", "125.07"], ["EUR", "12.34"]]) {
       const value = Money.of(amount, currency);
       await finance.createFinancialTransaction({ reference: randomUUID(), description: "Original wallet journal", occurredAt: new Date("2026-03-08T14:00:00Z"),
         idempotencyKey: randomUUID(), createdBy: f.account.id, postings: [
           { ledgerAccountId: f.bank.id, side: "CREDIT", amount: value, bucket: "REPORT_WALLET", dimensions: {} },
           { ledgerAccountId: wallet.id, side: "DEBIT", amount: value, bucket: "REPORT_WALLET", dimensions: {} }
         ] });
     }
     return performer;
   });
   const filter = { fromOn: "2026-03-08", toOn: "2026-03-08", currency: "MAD" };
   const original = await financial(f), report = await getTeamPerformanceReport(ctx, filter, { db });
   expect(report.people).toHaveLength(2);
   expect(report.people.find(row => row.id === f.person.id)).toMatchObject({ assigned: "2", open: "1", completed: "0" });
   const actual = report.people.find(row => row.id === performer.id);
   expect(actual).toMatchObject({ assigned: "0", completed: "1", onTime: "1", walletDebits: "125.07" });
   expect(teamReportMetrics(actual!, "MAD")).toContainEqual(expect.objectContaining({ key: "onTimeJobs", count: "100.00%" }));
   const eur = await getTeamPerformanceReport(ctx, { ...filter, currency: "EUR" }, { db });
   expect(eur.people.find(row => row.id === performer.id)?.walletDebits).toBe("12.34");
   await expect(getTeamPerformanceReport(f.ctx, filter, { db })).rejects.toBeInstanceOf(PerformanceReportAccessError);
   expect(JSON.stringify(report)).not.toContain("WALLET_TEAM_REPORT");
   expect(await financial(f)).toEqual(original);
 });

 it("includes the actual native cash collection through its tenant-scoped source despite legacy camel-case posting dimensions",async()=>{
  const f=await fixture(),task=await withTenant(db,f.org,async tx=>{const row=await tx.operationTask.create({data:{organizationId:f.org,propertyId:f.property.id,assignedToUserAccountId:f.account.id,assignedToPersonId:f.person.id,type:"TRANSFER",state:"ASSIGNED",dueDate:new Date(f.on),titleTranslations:{en:"Actual collected service",fr:"Service encaissé"},idempotencyKey:randomUUID(),createdBy:f.account.id}}),roles=await tx.role.findMany({where:{organizationId:f.org,key:{in:["driver","field_staff"]}}});expect(roles).toHaveLength(2);for(const role of roles)await tx.roleAssignment.create({data:{organizationId:f.org,roleId:role.id,userAccountId:f.account.id,personId:f.person.id,scopeType:"job",scopeId:row.id,validFrom:new Date("2020-01-01")}});return row;});
  const actor={...f.ctx,personId:f.person.id,authContext:{...await authContextForAccount(f.org,f.account.id,{db}),personId:f.person.id}},receipt=await withTenant(db,f.org,tx=>recordFieldCashInTransaction(actor,{taskId:task.id,amount:"0.09",currency:"MAD",payer:"Actual native service guest",purpose:"Actual native service cash collection",expectedRevision:cashCollectionRevision(task.id,task.version,0n)},{deviceId:randomUUID(),clientOpId:randomUUID(),clientCreatedAt:null},tx,{requestId:randomUUID(),ipAddress:null})),original=await financial(f),dimensions=await withTenant(db,f.org,tx=>tx.posting.findMany({select:{dimensions:true}}));expect(dimensions).toHaveLength(2);expect(dimensions.every(p=>(p.dimensions as Record<string,unknown>).propertyId===f.property.id&&!("property_id"in(p.dimensions as Record<string,unknown>)))).toBe(true);
  const actual=await getPropertyFinance(actor,query(f),{db});expect(actual.items).toHaveLength(2);expect(actual.items.every(p=>p.reference==="CASH:"+receipt.id&&p.amount==="0.09")).toBe(true);expect(actual.accounts.find(a=>a.accountType==="ASSET_LOCATION")).toMatchObject({opening:"0.00",debits:"0.09",closing:"0.09"});expect(actual.accounts.find(a=>a.accountType==="CLAIM_OWNERSHIP")).toMatchObject({credits:"0.09",closing:"0.09"});expect(await financial(f)).toEqual(original);
 });
 it("shows the actual configured mortgage and its exact opposite without rewriting original journals or mixing location with ownership",async()=>{
  const f=await fixture(),posted=await mortgage(f),original=await financial(f),first=await getPropertyFinance(f.ctx,query(f),{db});expect(first.items).toHaveLength(2);expect(first.items.every(row=>row.transactionId===posted.transactionId&&row.amount==="0.07"&&row.expenseId===posted.id)).toBe(true);expect(first.accounts.find(row=>row.accountType==="ASSET_LOCATION")).toMatchObject({closing:"-0.07",credits:"0.07"});expect(first.accounts.some(row=>row.accountType==="CLAIM_OWNERSHIP")).toBe(true);expect(await financial(f)).toEqual(original);
  await voidExpense(f.ctx,{id:posted.id,expectedVersion:posted.version,reason:"Append the actual mortgage payment opposite without deleting history"},{db});const after=await financial(f),restored=await getPropertyFinance(f.ctx,query(f),{db});expect(restored.items).toHaveLength(4);expect(restored.items.every(row=>row.expenseId===posted.id)).toBe(true);expect(restored.accounts.every(row=>row.closing==="0.00")).toBe(true);expect(after.filter(row=>original.some(source=>source.kind===row.kind&&source.id===row.id))).toEqual(original);expect(await financial(f)).toEqual(after);
 });
 it("keeps actual currencies and prior-period opening positions separate",async()=>{
  const f=await fixture(),previous=new Date(f.on+"T12:00:00Z");previous.setUTCDate(previous.getUTCDate()-1);await mortgage(f,"0.09","MAD",previous.toISOString().slice(0,10));await mortgage(f,"0.07");await mortgage(f,"0.09","EUR");
  const mad=await getPropertyFinance(f.ctx,query(f),{db}),eur=await getPropertyFinance(f.ctx,{...query(f),currency:"EUR"},{db});expect(mad.items).toHaveLength(2);expect(mad.accounts.find(row=>row.accountType==="ASSET_LOCATION")).toMatchObject({currency:"MAD",opening:"-0.09",credits:"0.07",closing:"-0.16"});expect(eur.accounts.find(row=>row.accountType==="ASSET_LOCATION")).toMatchObject({currency:"EUR",opening:"0.00",credits:"0.09",closing:"-0.09"});
 });
 it("denies foreign tenants, retained caller restrictions and revoked independent salary authority without private output",async()=>{
  const f=await fixture(),other=await fixture();await mortgage(f);await expect(getPropertyFinance(other.ctx,query(f),{db})).rejects.toBeInstanceOf(PropertyFinanceAccessError);const narrowed={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set<string>(),assignments:[],scopes:[]}};await expect(getPropertyFinance(narrowed,query(f),{db})).rejects.toBeInstanceOf(PropertyFinanceAccessError);
  await withTenant(db,f.org,async tx=>{const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.org,key:"staff_compensation:view"}});await tx.rolePermission.deleteMany({where:{roleId:f.role.id,permissionId:permission.id}});});await expect(getPropertyFinance(f.ctx,query(f),{db})).rejects.toBeInstanceOf(PropertyFinanceAccessError);expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{resourceType:"property_finance"}}))).toBe(0);expect(await withTenant(db,other.org,tx=>tx.posting.count())).toBe(0);
 });
 it("rolls back the private read audit if current authority expires at its final boundary",async()=>{
  const f=await fixture();await mortgage(f);const original=await financial(f),writer=auditWriter.writeAuditEvent,spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{await writer(tx,event);if(event.action==="finance.property_finance.viewed")await(tx as unknown as TenantTransaction).roleAssignment.update({where:{id:f.grant.id},data:{validTo:new Date(Date.now()-1000)}});});
  try{await expect(getPropertyFinance(f.ctx,query(f),{db})).rejects.toBeInstanceOf(PropertyFinanceAccessError);}finally{spy.mockRestore();}expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{resourceType:"property_finance"}}))).toBe(0);expect(await financial(f)).toEqual(original);
 });
 it("detects an actually appended journal during the read instead of presenting stale positions",async()=>{
  const f=await fixture();await mortgage(f);const original=await financial(f),writer=auditWriter.writeAuditEvent;let appended=false;const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{await writer(tx,event);if(!appended&&event.action==="finance.property_finance.viewed"){appended=true;await mortgage(f,"0.09");}});
  try{await expect(getPropertyFinance(f.ctx,query(f),{db})).rejects.toBeInstanceOf(PropertyFinanceSourceChangedError);}finally{spy.mockRestore();}expect(appended).toBe(true);expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{resourceType:"property_finance"}}))).toBe(0);const after=await financial(f);expect(after.filter(row=>original.some(source=>source.kind===row.kind&&source.id===row.id))).toEqual(original);expect((await getPropertyFinance(f.ctx,query(f),{db})).accounts.find(row=>row.accountType==="ASSET_LOCATION")?.closing).toBe("-0.16");
 });
 it("masks property financial read history and requires independent financial export authority",async()=>{
  const f=await fixture();await mortgage(f);await getPropertyFinance(f.ctx,query(f),{db});const history=await listAuditHistory({...f.ctx,personId:f.person.id},{resourceType:"property_finance"},{db});expect(history.rows).toHaveLength(1);expect(history.rows[0].after).toMatchObject({accountCount:2});
  const auditOnly=await withTenant(db,f.org,async tx=>{const person=await tx.person.create({data:{organizationId:f.org,displayName:"Actual audit-only property reviewer"}}),account=await tx.userAccount.create({data:{organizationId:f.org,personId:person.id}}),role=await tx.role.create({data:{organizationId:f.org,key:"property_audit_only",name:"Actual separate audit access"}}),permissions=await tx.permission.findMany({where:{organizationId:f.org,key:{in:["audit_log:view","audit_log:export"]}}});await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:role.id,permissionId:permission.id}))});await tx.roleAssignment.create({data:{organizationId:f.org,roleId:role.id,userAccountId:account.id,personId:person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});return{person,account};}),ctx={organizationId:f.org,actorId:auditOnly.account.id,personId:auditOnly.person.id,authContext:await authContextForAccount(f.org,auditOnly.account.id,{db})};
  const hidden=await listAuditHistory(ctx,{resourceType:"property_finance"},{db});expect(hidden.rows[0].after).toBe(maskedValue);expect(hidden.rows[0].reason).toBe(maskedValue);const csv=await exportAuditHistoryCsv({...f.ctx,personId:f.person.id},{resourceType:"property_finance"},{db});expect(csv).not.toContain("accountCount");
 });
 it("retains actual financial history after the property is archived",async()=>{
  const f=await fixture();await mortgage(f);const original=await financial(f);await withTenant(db,f.org,tx=>tx.property.update({where:{id:f.property.id},data:{archivedAt:new Date()}}));const result=await getPropertyFinance(f.ctx,query(f),{db});expect(result.property.archived).toBe(true);expect(result.items).toHaveLength(2);expect(await financial(f)).toEqual(original);
 });
 it("reaches every original posting beyond two history pages and rejects stale or altered continuation",async()=>{
  const f=await fixture();for(let index=0;index<52;index++)await mortgage(f,"0.01");const original=await financial(f),first=await getPropertyFinance(f.ctx,query(f),{db});expect(first.items).toHaveLength(50);expect(first.next).not.toBeNull();const second=await getPropertyFinance(f.ctx,{...query(f),after:first.next!},{db});expect(second.items).toHaveLength(50);expect(second.next).not.toBeNull();const third=await getPropertyFinance(f.ctx,{...query(f),after:second.next!},{db});expect(third.items).toHaveLength(4);expect(third.next).toBeNull();expect(new Set([...first.items,...second.items,...third.items].map(row=>row.id)).size).toBe(104);expect(first.accounts.find(row=>row.accountType==="ASSET_LOCATION")).toMatchObject({closing:"-0.52",postingCount:"52"});expect(await financial(f)).toEqual(original);
  await expect(getPropertyFinance(f.ctx,{...query(f),currency:"EUR",after:first.next!},{db})).rejects.toBeInstanceOf(PropertyFinanceSourceChangedError);await expect(getPropertyFinance(f.ctx,{...query(f),after:"forged-property-history-token"},{db})).rejects.toBeInstanceOf(PropertyFinanceAccessError);await mortgage(f,"0.01");await expect(getPropertyFinance(f.ctx,{...query(f),after:first.next!},{db})).rejects.toBeInstanceOf(PropertyFinanceSourceChangedError);
 });
 it("keeps discovery queries constant as the actual portfolio grows to 500 properties",async()=>{
  const f=await fixture();await mortgage(f);const target=new URL(url!);target.username="alvillas_ops_tests";target.password="alvillas_ops_tests";target.searchParams.set("connection_limit","1");const measured=new PrismaClient({datasourceUrl:target.toString(),log:[{emit:"event",level:"query"}]}),queries:string[]=[];measured.$on("query",event=>{if(!/^SELECT 1$/iu.test(event.query.trim()))queries.push(event.query);});
  try{const read=async()=>{await withTenant(measured,f.org,tx=>tx.$queryRaw`SELECT 1`);await new Promise<void>(resolve=>setImmediate(resolve));queries.length=0;const data=await getPropertyFinance(f.ctx,query(f),{db:measured});await new Promise<void>(resolve=>setImmediate(resolve));return{data,queries:queries.length};},one=await read();
   await withTenant(db,f.org,tx=>tx.property.createMany({data:Array.from({length:499},(_,index)=>({organizationId:f.org,name:"Actual portfolio property "+index,addressLine1:"Actual portfolio",city:"Marrakech",timezone:"UTC",propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}))}));const many=await read();expect(await withTenant(db,f.org,tx=>tx.property.count())).toBe(500);expect(many.queries).toBe(one.queries);expect(many.data.accounts).toEqual(one.data.accounts);expect(many.data.items).toEqual(one.data.items);
  }finally{await measured.$disconnect();}
 });
});
