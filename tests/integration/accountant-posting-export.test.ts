import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { financialRuleSourceChecks } from "@/platform/config/financial-rule-authority";
import { propertyFinancePartySources } from "@/platform/authz/property-finance-resource";
import { accountantExportAuthorityChecks } from "@/platform/authz/accountant-export-resource";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import * as auditWriter from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";
import { hashRateLimitKey } from "@/platform/rate-limit/postgres-rate-limiter";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { AccountantPostingExportRepository } from "@/modules/finance/infrastructure/accountant-posting-export-repository";
import { prepareAccountantExport, readAccountantExportEditor } from "@/modules/finance/application/accountant-export-service";
import { renderAccountantCsv, renderAccountantExcel, type AccountantExportLabels } from "@/modules/finance/infrastructure/accountant-tabular-renderer";
import { AccountantPdfRenderer, accountantPdfTemplate } from "@/modules/finance/infrastructure/accountant-pdf-renderer";
import { strFromU8, unzipSync } from "fflate";
import en from "../../messages/en.json";
import { accountantExportPolicyKey } from "@/modules/finance/domain/accountant-export-policy";
import { AccountantExportAccessError, AccountantExportCapacityError, AccountantExportChangedError, AccountantExportRateLimitError } from "@/modules/finance/domain/accountant-export";
import { listAuditHistory } from "@/modules/audit/application/audit-service";
import { maskedValue } from "@/platform/authz/present";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";
import { actualBankReconciliationFixture } from "./support/bank-reconciliation-fixture";
import { reviewBankReconciliation, matchBankStatement, releaseBankReconciliation } from "@/modules/finance/application/bank-reconciliation-service";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated native accountant export database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const restricted = new URL(url!); restricted.username = restricted.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: restricted.toString() });
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture(options: { maxRows?: number; requests?: number } = {}) {
  const f = await actualGuestDepositFixture(db, admin), policy = { source: "ORIGINAL_POSTED_FINANCIAL_SOURCES", reports: ["TRANSACTIONS", "INCOME", "EXPENSES"], formats: ["CSV", "EXCEL", "PDF"],
    classifications: { income: { buckets: ["EXPLICIT_FIXTURE_REVENUE"], account_types: ["ALVILLAS_OWN"], sides: ["CREDIT"] },
      expenses: { buckets: ["EXPLICIT_FIXTURE_COST"], account_types: ["ALVILLAS_OWN"], sides: ["DEBIT"] } },
    capacity: { CSV: options.maxRows ?? 100, EXCEL: 100, PDF: 20 }, rate_limit: { requests: options.requests ?? 20, window_seconds: 3600 } };
  const prepared = await withTenant(db, f.org, async tx => {
    await tx.organizationProfile.create({ data: { organizationId: f.org, brandName: "Actual accountant export organization", timezone: "UTC" } });
    const keys = [...new Set([...financialRuleSourceChecks(f.org, accountantExportPolicyKey, "export").map(check => check.resource.type + ":" + check.action),
      ...propertyFinancePartySources.flatMap(type => [type + ":view", type + ":export"]), "property:view", "property:export", "config_rule:view", "audit_log:view"])];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })), skipDuplicates: true });
    const rule = await new ConfigRuleRepository(tx, f.org).createVersion({ key: accountantExportPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      createdBy: f.account.id, value: policy, reason: "Explicit native fixture export classifications, capacity and admission" });
    const finance = new FinanceRepository(tx, f.org), revenue = await finance.ensureLedgerAccount({ code: "ACTUAL_EXPORT_REVENUE", name: "Actual configured revenue ownership", accountType: "ALVILLAS_OWN", normalSide: "CREDIT" }),
      cost = await finance.ensureLedgerAccount({ code: "ACTUAL_EXPORT_COST", name: "Actual configured expense ownership", accountType: "ALVILLAS_OWN", normalSide: "DEBIT" });
    const dimensions = { property_id: f.property.id, person_id: f.person.id }, amount = Money.of("9007199254740993.07", "MAD");
    const original = await finance.createFinancialTransaction({ reference: "ACTUAL-EXPORT:" + randomUUID(), occurredAt: new Date("2031-05-01T00:00:00Z"), description: "=Original configured income <&> evidence", idempotencyKey: randomUUID(), createdBy: f.account.id,
      postings: [{ ledgerAccountId: f.banks.receipt.id, side: "DEBIT", amount, bucket: "EXPLICIT_FIXTURE_REVENUE", dimensions }, { ledgerAccountId: revenue.id, side: "CREDIT", amount, bucket: "EXPLICIT_FIXTURE_REVENUE", dimensions }] });
    const expense = await finance.createFinancialTransaction({ reference: "ACTUAL-COST:" + randomUUID(), occurredAt: new Date("2031-05-02T00:00:00Z"), description: "Actual three-cent configured cost", idempotencyKey: randomUUID(), createdBy: f.account.id,
      postings: [{ ledgerAccountId: cost.id, side: "DEBIT", amount: Money.of("0.03", "MAD"), bucket: "EXPLICIT_FIXTURE_COST", dimensions }, { ledgerAccountId: f.banks.receipt.id, side: "CREDIT", amount: Money.of("0.03", "MAD"), bucket: "EXPLICIT_FIXTURE_COST", dimensions }] });
    return { rule, original, expense, revenue, cost };
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
  return { ...f, ...prepared, policy, ctx };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const input = { kind: "TRANSACTIONS", format: "CSV", locale: "fr", fromOn: "2031-05-01", toOn: "2031-05-31", currency: "MAD", reason: "Export actual original accountant source evidence" };
const snapshot = (f: Pick<Fixture, "org">) => withTenant(db, f.org, tx => tx.$queryRaw`
  SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);
const admissionCount = (f: Fixture) => withTenant(db, f.org, async tx => (await tx.rateLimitBucket.findMany({ where: { keyHash: hashRateLimitKey("finance.accountant_exports:" + f.account.id) } })).reduce((sum, row) => sum + row.count, 0));

describe("native complete accountant posting exports", () => {
  it("retains historical bank bindings and their original expected legs after configuration changes before any bank statement import",async()=>{
    const f=await fixture(),oldCode=f.banks.receipt.code;
    await withTenant(db,f.org,async tx=>{const rules=new ConfigRuleRepository(tx,f.org),bankPolicy={source:"ORIGINAL_BANK_STATEMENT",accounts:[{account_code:oldCode,bank_id:"actual-historical-bank",branch_id:null,account_id:"actual-retained-account",account_type:"CHECKING",currency:"MAD",csv:null,ofx:true}],encoding:"UTF-8",max_bytes:1000000,max_rows:5000,matching:{date_window_days:0,amount_tolerance:"0.00",reference:"EXACT",admission:"EXPLICIT_REVIEW",ledger_effect:"NONE"},source_corrections:"APPEND_AND_REOPEN_REVIEW",duplicate_csv_without_id:"RETAIN_EVERY_ROW"};
      await rules.createVersion({key:"finance.bank_statements",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:bankPolicy,reason:"Retain actual original bank binding before the first statement arrives"});
      const next=await new FinanceRepository(tx,f.org).ensureLedgerAccount({code:"NEW_ACTUAL_EXPORT_BANK",name:"New actual current bank binding",accountType:"ASSET_LOCATION",normalSide:"DEBIT"});
      await rules.createVersion({key:"finance.bank_statements",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{...bankPolicy,accounts:[{...bankPolicy.accounts[0],account_code:next.code,account_id:"actual-new-current-account"}]},reason:"Change current actual bank configuration without erasing historical bank movements"});
      await rules.createVersion({key:accountantExportPolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{...f.policy,reports:[...f.policy.reports,"BANK_RECONCILIATION"]},reason:"Explicit complete original bank accountant export policy"});
    });
    const before=await snapshot(f),source=await prepareAccountantExport(f.ctx,{...input,kind:"BANK_RECONCILIATION",accountId:f.banks.receipt.id},document=>document,{db});expect(source.rows).toHaveLength(2);expect(source.rows.every(row=>row.cells.recordType?.value==="BANK_EXPECTED"&&row.cells.accountId?.value===f.banks.receipt.id)).toBe(true);
    expect(source.rows.some(row=>row.cells.amount?.value==="9007199254740993.07")).toBe(true);expect(await withTenant(db,f.org,tx=>tx.bankStatementLine.count())).toBe(0);
    const choices=await readAccountantExportEditor(f.ctx,{locale:"en",choice:"bank",currency:"MAD"},{db});expect(choices.choices.map(row=>row.id)).toContain(f.banks.receipt.id);expect(await snapshot(f)).toEqual(before);
  });
  it("renders original native financial records through real CSV, Excel and PDF without changing journals or losing exact money", async () => {
    const f=await fixture(),before=await snapshot(f),messages=en.AccountantExports,labels:AccountantExportLabels={title:messages.reports.TRANSACTIONS,headers:messages.columns,metadata:messages.metadata,metadataRow:messages.metadataRow,sourceRow:messages.sourceRow,metadataSheet:messages.metadataSheet,dataSheet:messages.dataSheet};
    const csv=await prepareAccountantExport(f.ctx,input,renderAccountantCsvDocument,{db});
    function renderAccountantCsvDocument(source:Parameters<typeof renderAccountantCsv>[0],maxRows:number){return renderAccountantCsv(source,labels,maxRows);}
    expect(new TextDecoder().decode(csv)).toContain("9007199254740993.07");
    const excel=await prepareAccountantExport(f.ctx,{...input,format:"EXCEL"},(source,maxRows)=>renderAccountantExcel(source,labels,"fr",maxRows),{db}),archive=unzipSync(excel),xml=Object.entries(archive).filter(([name])=>name.endsWith(".xml")).map(([,bytes])=>strFromU8(bytes)).join("\n");
    expect(xml).toContain("9007199254740993.07");expect(xml).not.toMatch(/<f(?:\s|>)/u);
    const pdf=await prepareAccountantExport(f.ctx,{...input,format:"PDF"},(source,maxRows)=>new AccountantPdfRenderer().render({template:accountantPdfTemplate,locale:"en",data:{source,labels,maxRows}}),{db});
    expect(new TextDecoder().decode(pdf.slice(0,5))).toBe("%PDF-");expect(await snapshot(f)).toEqual(before);
    expect(await withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.accountant_export.generated"}}))).toBe(3);
  });
  it("exports every actual posting across 500 additional properties and pages the entire native selector without silent truncation",async()=>{
    const f=await fixture({maxRows:2000,requests:100}),properties=Array.from({length:500},(_,index)=>({id:randomUUID(),organizationId:f.org,name:"Actual accountant portfolio "+String(index).padStart(3,"0"),addressLine1:"Actual native portfolio",city:"Marrakech",propertyType:"VILLA",bedrooms:2,bathrooms:2,maxGuests:4,amenities:[],photoUrls:[]}));
    await withTenant(db,f.org,async tx=>{await tx.property.createMany({data:properties});const finance=new FinanceRepository(tx,f.org);await finance.createFinancialTransactions(properties.map(property=>({reference:"ACTUAL-PORTFOLIO:"+property.id,idempotencyKey:randomUUID(),occurredAt:new Date("2031-05-03T00:00:00Z"),description:"Actual seven-cent original portfolio receipt",createdBy:f.account.id,postings:[{ledgerAccountId:f.banks.receipt.id,side:"DEBIT" as const,amount:Money.of("0.07","MAD"),bucket:"EXPLICIT_FIXTURE_REVENUE",dimensions:{property_id:property.id}},{ledgerAccountId:f.revenue.id,side:"CREDIT" as const,amount:Money.of("0.07","MAD"),bucket:"EXPLICIT_FIXTURE_REVENUE",dimensions:{property_id:property.id}}]})),()=>Promise.resolve());});
    const before=await snapshot(f),source=await prepareAccountantExport(f.ctx,input,document=>document,{db});expect(source.rows).toHaveLength(1004);
    const ids=new Set(source.rows.map(row=>row.cells.propertyId?.value));for(const property of properties)expect(ids.has(property.id)).toBe(true);
    const all=new Set<string>();let after:string|undefined,pages=0;do{const page=await readAccountantExportEditor(f.ctx,{locale:"en",choice:"property",query:"Actual accountant portfolio",after},{db});for(const option of page.choices){expect(all.has(option.id)).toBe(false);all.add(option.id);}after=page.next??undefined;pages++;expect(pages).toBeLessThan(20);}while(after);
    expect(all).toEqual(new Set(properties.map(property=>property.id)));expect(pages).toBe(17);
    const filtered=await prepareAccountantExport(f.ctx,{...input,propertyId:properties[499].id},document=>document,{db});expect(filtered.rows).toHaveLength(2);expect(filtered.scope.propertyId).toBe(properties[499].id);
    const empty=await prepareAccountantExport(f.ctx,{...input,propertyId:properties[499].id,fromOn:"2031-05-04"},document=>document,{db});expect(empty.rows).toHaveLength(0);expect(empty.scope.propertyId).toBe(properties[499].id);
    expect(await snapshot(f)).toEqual(before);
  });
  it("exports immutable actual source identity and exact large money while keeping custody distinct from configured revenue", async () => {
    const f = await fixture(), before = await snapshot(f), all = await prepareAccountantExport(f.ctx, input, source => source, { db });
    expect(all.rows).toHaveLength(4); expect(all.rows.filter(row => row.cells.amount?.value === "9007199254740993.07")).toHaveLength(2);
    expect(new Set(all.rows.map(row => row.cells.accountType?.value))).toEqual(new Set(["ASSET_LOCATION", "ALVILLAS_OWN"]));
    const income = await prepareAccountantExport(f.ctx, { ...input, kind: "INCOME" }, source => source, { db });
    expect(income.rows).toHaveLength(1); expect(income.rows[0].cells).toMatchObject({ accountId: { value: f.revenue.id }, side: { value: "CREDIT" }, amount: { value: "9007199254740993.07" } });
    const expense = await prepareAccountantExport(f.ctx, { ...input, kind: "EXPENSES" }, source => source, { db });
    expect(expense.rows).toHaveLength(1); expect(expense.rows[0].cells.amount?.value).toBe("0.03");
    expect(await snapshot(f)).toEqual(before);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "accountant_export" } }))).toBe(3);
  });
  it("retains original and reversing income movements even when the configured recognition side is CREDIT", async () => {
    const f = await fixture();
    const opposite = await withTenant(db, f.org, async tx => {
      const row = await new FinanceRepository(tx, f.org).createFinancialTransaction({ reference: "ACTUAL-OPPOSITE:" + randomUUID(), occurredAt: new Date("2031-05-03T00:00:00Z"),
      description: "Actual original income opposite", idempotencyKey: randomUUID(), createdBy: f.account.id, reversesTransactionId: f.original.id,
      postings: f.original.postings.map(posting => ({ ledgerAccountId: posting.ledgerAccountId, side: posting.side === "CREDIT" ? "DEBIT" : "CREDIT", amount: Money.of(posting.amount.toString(), posting.currency), bucket: posting.bucket!, dimensions: { property_id: f.property.id, person_id: f.person.id } })) });
      await auditWriter.writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "finance.fixture.reversed", resourceType: "financial_transaction", resourceId: f.original.id,
        after: { originalTransactionIds: [f.original.id], reversalTransactionIds: [row.id] }, reason: "Actual attributed source reversal for native export verification", requestId: randomUUID(), occurredAt: new Date("2031-05-03T00:00:00Z") });
      return row;
    });
    const before = await snapshot(f), report = await prepareAccountantExport(f.ctx, { ...input, kind: "INCOME" }, source => source, { db });
    expect(report.rows).toHaveLength(2); expect(report.rows.map(row => row.cells.side?.value)).toEqual(["CREDIT", "DEBIT"]);
    expect(report.rows[1].cells).toMatchObject({ transactionId: { value: opposite.id }, reversesTransactionId: { value: f.original.id }, amount: { value: "9007199254740993.07" } });
    expect(await snapshot(f)).toEqual(before);
  });
  it("keeps failed rendering and capacity refusal in the durable admission budget without writing a success audit", async () => {
    const f = await fixture({ requests: 2, maxRows: 1 }), render = vi.fn(() => "attachment");
    await expect(prepareAccountantExport(f.ctx, input, render, { db })).rejects.toThrow(AccountantExportCapacityError); expect(render).not.toHaveBeenCalled();
    await expect(prepareAccountantExport(f.ctx, { ...input, kind: "INCOME" }, () => { throw Error("Actual renderer failure"); }, { db })).rejects.toThrow("Actual renderer failure");
    expect(await admissionCount(f)).toBe(2);
    await expect(prepareAccountantExport(f.ctx, input, render, { db })).rejects.toThrow(AccountantExportRateLimitError);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "accountant_export" } }))).toBe(0);
  });
  it("rechecks held and stored source authority and refuses foreign native property filters", async () => {
    const f = await fixture(), other = await fixture(), before = await snapshot(f);
    const held = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(key => key !== "staff_compensation:export")) } };
    await expect(prepareAccountantExport(held, input, source => source, { db })).rejects.toThrow(AccountantExportAccessError); expect(await admissionCount(f)).toBe(0);
    await expect(prepareAccountantExport(f.ctx, { ...input, propertyId: other.property.id }, source => source, { db })).rejects.toThrow(AccountantExportAccessError);
    await withTenant(db, f.org, async tx => { const permission = await tx.permission.findFirstOrThrow({ where: { key: "staff_compensation:export" } }); await tx.rolePermission.deleteMany({ where: { roleId: f.role.id, permissionId: permission.id } }); });
    await expect(prepareAccountantExport(f.ctx, input, source => source, { db })).rejects.toThrow(AccountantExportAccessError); expect(await snapshot(f)).toEqual(before);
    const foreign = await withTenant(db, f.org, tx => new AccountantPostingExportRepository(tx, other.org).postings({ currency: "MAD", startsAt: new Date("2031-05-01"), endsAt: new Date("2031-06-01"), maxRows: 100 }));
    expect(foreign).toEqual([]);
  });
  it("does not return rendered bytes after a concurrent native posting changes the complete source", async () => {
    const f = await fixture(), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await original(tx, event);
      if (event.resourceType === "accountant_export") await withTenant(db, f.org, other => new FinanceRepository(other, f.org).createFinancialTransaction({
        reference: "ACTUAL-LATE:" + randomUUID(), occurredAt: new Date("2031-05-04T00:00:00Z"), description: "Actual concurrent source movement", idempotencyKey: randomUUID(), createdBy: f.account.id,
        postings: [{ ledgerAccountId: f.revenue.id, side: "CREDIT", amount: Money.of("0.07", "MAD"), bucket: "EXPLICIT_FIXTURE_REVENUE", dimensions: {} },
          { ledgerAccountId: f.banks.receipt.id, side: "DEBIT", amount: Money.of("0.07", "MAD"), bucket: "EXPLICIT_FIXTURE_REVENUE", dimensions: {} }] }));
      return result;
    });
    try { await expect(prepareAccountantExport(f.ctx, input, () => new Uint8Array([1, 2, 3]), { db })).rejects.toThrow(AccountantExportChangedError); } finally { spy.mockRestore(); }
    expect(await admissionCount(f)).toBe(1); expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "accountant_export" } }))).toBe(0);
  });
  it("withholds rendered bytes and the success audit when the configured classification changes at the final fence", async () => {
    const f = await fixture(), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await original(tx, event);
      if (event.resourceType === "accountant_export") await withTenant(db, f.org, other => new ConfigRuleRepository(other, f.org).createVersion({
        key: accountantExportPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
        value: { ...f.policy, classifications: { ...f.policy.classifications, income: { ...f.policy.classifications.income, buckets: ["NEW_EXPLICIT_FIXTURE_REVENUE"] } } },
        reason: "Actual independently published accountant classification change" }));
      return result;
    });
    try { await expect(prepareAccountantExport(f.ctx, input, () => new Uint8Array([1, 2, 3]), { db })).rejects.toThrow(AccountantExportChangedError); } finally { spy.mockRestore(); }
    expect(await admissionCount(f)).toBe(1); expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "accountant_export" } }))).toBe(0);
  });
  it("does not disclose an attachment after stored source-export authority ends while it is being rendered", async () => {
    const f = await fixture(), before = await snapshot(f);
    await expect(prepareAccountantExport(f.ctx, input, async () => {
      await withTenant(db, f.org, async other => { const permission = await other.permission.findFirstOrThrow({ where: { key: "company_ledger:export" } });
        await other.rolePermission.deleteMany({ where: { roleId: f.role.id, permissionId: permission.id } }); });
      return new Uint8Array([1, 2, 3]);
    }, { db })).rejects.toThrow(AccountantExportAccessError);
    expect(await snapshot(f)).toEqual(before); expect(await admissionCount(f)).toBe(1);
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceType: "accountant_export" } }))).toBe(0);
  });
  it("does not invalidate a complete MAD source when an unrelated currency is registered concurrently", async () => {
    const f = await fixture(), before = await snapshot(f);
    const report = await prepareAccountantExport(f.ctx, input, async source => {
      await withTenant(db, f.org, tx => tx.currency.upsert({ where: { code: "XTS" }, update: {}, create: { code: "XTS", name: "Explicit test currency", minorUnit: 2 } })); return source;
    }, { db });
    expect(report.currency).toBe("MAD"); expect(report.rows).toHaveLength(4); expect(await snapshot(f)).toEqual(before);
  });
  it("masks exported scope, metadata and reasons from a generic audit reader missing an independent source root", async () => {
    const f = await fixture(); await prepareAccountantExport(f.ctx, input, source => source, { db });
    expect((await listAuditHistory(f.ctx, { resourceType: "accountant_export" }, { db })).rows[0].after).toMatchObject({ rowCount: 4 });
    for (const key of ["company_ledger:view", "staff_compensation:view", "supplier:view", "config_rule:view", "property:view"]) {
      const ctx = { ...f.ctx, authContext: { ...f.ctx.authContext, permissions: new Set([...f.ctx.authContext.permissions].filter(permission => permission !== key)) } };
      const history = await listAuditHistory(ctx, { resourceType: "accountant_export" }, { db }); expect(history.rows).toHaveLength(1);
      expect(history.rows[0]).toMatchObject({ before: maskedValue, after: maskedValue, reason: maskedValue });
    }
  });
  it("reuses original owner statement balances, preserves microsecond movement order and retains archived owner history", async () => {
    const f = await fixture(), owner = await withTenant(db, f.org, tx => tx.owner.findFirstOrThrow());
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: accountantExportPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"),
      createdBy: f.account.id, value: { ...f.policy, reports: [...f.policy.reports, "OWNER_STATEMENTS"] }, reason: "Explicit native owner statement export policy" }));
    async function append(at: string, side: "DEBIT" | "CREDIT", amount: string) {
      return withTenant(db, f.org, async tx => {
        const account = await new FinanceRepository(tx, f.org).ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Actual owner ownership", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
        const id = randomUUID(), value = Money.of(amount, "MAD");
        await tx.$executeRaw(Prisma.sql`INSERT INTO financial_transaction(id,organization_id,reference,description,occurred_at,idempotency_key,created_by)
          VALUES(${id}::uuid,${f.org}::uuid,${"OWNER-EXPORT:" + id},'Actual original owner statement movement',${at}::timestamptz,${randomUUID()},${f.account.id}::uuid)`);
        await tx.posting.createMany({ data: [{ organizationId: f.org, transactionId: id, ledgerAccountId: account.id, side, amount: value.toJSON().amount, currency: "MAD", bucket: side === "CREDIT" ? "OWNER_REVENUE" : "OWNER_EXPENSE", dimensions: { property_id: f.property.id, owner_id: owner.id } },
          { organizationId: f.org, transactionId: id, ledgerAccountId: f.banks.receipt.id, side: side === "CREDIT" ? "DEBIT" : "CREDIT", amount: value.toJSON().amount, currency: "MAD", bucket: side === "CREDIT" ? "OWNER_REVENUE" : "OWNER_EXPENSE", dimensions: { property_id: f.property.id, owner_id: owner.id } }] });
        await auditWriter.writeAuditEvent(tx, { organizationId: f.org, actorId: f.account.id, action: "finance.fixture.posted", resourceType: "financial_transaction", resourceId: id,
          after: { transactionId: id }, reason: "Actual original native owner report movement", requestId: randomUUID(), occurredAt: await new FinanceRepository(tx, f.org).clock() }); return id;
      });
    }
    await append("2031-04-30T23:59:59.999999Z", "CREDIT", "100.07");
    const credit = await append("2031-05-01T00:00:00.000001Z", "CREDIT", "0.07"), debit = await append("2031-05-01T00:00:00.000002Z", "DEBIT", "0.03");
    await withTenant(db, f.org, tx => tx.owner.update({ where: { id: owner.id }, data: { archivedAt: new Date() } }));
    const before = await snapshot(f), report = await prepareAccountantExport(f.ctx, { ...input, kind: "OWNER_STATEMENTS", ownerId: owner.id }, source => source, { db });
    expect(report.rows).toHaveLength(3);
    expect(report.rows[0].cells).toMatchObject({ recordType: { value: "OWNER_SUMMARY" }, sourceId: { value: owner.id }, opening: { value: "100.07" }, credits: { value: "0.07" }, debits: { value: "0.03" }, closing: { value: "100.11" } });
    expect(report.rows.slice(1).map(row => row.cells.transactionId?.value)).toEqual([credit, debit]);
    expect(report.rows.slice(1).map(row => row.cells.occurredAt?.value)).toEqual(["2031-05-01T00:00:00.000001Z", "2031-05-01T00:00:00.000002Z"]);
    expect(await snapshot(f)).toEqual(before);
  });
  it("exports original bank facts, negative actual allocations, current release state and unchanged financial history", async () => {
    const f = await actualBankReconciliationFixture(db, admin, ["-0.03"]);
    await withTenant(db, f.org, async tx => {
      await tx.organizationProfile.create({ data: { organizationId: f.org, brandName: "Actual bank accountant export", timezone: "UTC" } });
      const keys = [...new Set(accountantExportAuthorityChecks(f.org).map(check => check.resource.type + ":" + check.action))];
      const permissions = await tx.permission.findMany({ where: { key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
      await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })), skipDuplicates: true });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: accountantExportPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id,
        value: { source: "ORIGINAL_POSTED_FINANCIAL_SOURCES", reports: ["BANK_RECONCILIATION"], formats: ["CSV", "EXCEL", "PDF"], classifications: {}, capacity: { CSV: 100, EXCEL: 100, PDF: 100 }, rate_limit: { requests: 20, window_seconds: 3600 } },
        reason: "Explicit native bank report without inferred financial allocation" });
    });
    const actor = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
    const command = { action: "MATCH", accountId: f.banks.receipt.id, currency: "MAD", expected: [{ id: f.posting.id, amount: "0.07" }], actual: [{ id: f.lines[0].id, amount: "0.03" }],
      reason: "Actual original negative bank evidence", varianceAction: "Retain and review the original signed difference" };
    const review = await reviewBankReconciliation(actor, command, { db }), matched = await matchBankStatement(actor, { ...command, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID() }, { db });
    const today = f.receiptInput.receivedAt.slice(0, 10), dates = [today, "2026-11-03"].sort(), query = { ...input, kind: "BANK_RECONCILIATION", accountId: f.banks.receipt.id, fromOn: dates[0], toOn: dates[1] };
    const before = await snapshot(f), report = await prepareAccountantExport(actor, query, source => source, { db });
    expect(report.rows).toHaveLength(5);
    const match = report.rows.find(row => row.cells.recordType?.value === "BANK_MATCH");
    expect(match?.cells).toMatchObject({ sourceId: { value: matched.id }, expected: { value: "0.07" }, actual: { value: "-0.03" }, variance: { value: "-0.10" }, state: { value: "OPEN_VARIANCE" } });
    expect(report.rows.find(row => row.cells.recordType?.value === "BANK_ACTUAL_ALLOCATION")?.cells).toMatchObject({ statementLineId: { value: f.lines[0].id }, actual: { value: "-0.03" }, amount: { value: "0.03" } });
    expect(report.rows.find(row => row.cells.recordType?.value === "BANK_ACTUAL")?.cells).toMatchObject({ actual: { value: "-0.03" }, postedOn: { kind: "DATE", value: "2026-11-03" }, remaining: { value: "0.00" } });
    const released = await releaseBankReconciliation(actor, { action: "RELEASE", id: matched.id, idempotencyKey: randomUUID(), reason: "Actual independent release of original matching" }, { db });
    const after = await prepareAccountantExport(actor, query, source => source, { db });
    expect(after.sourceFingerprint).not.toBe(report.sourceFingerprint);
    expect(after.rows.find(row => row.cells.recordType?.value === "BANK_MATCH")?.cells).toMatchObject({ state: { value: "RELEASED" }, releaseId: { value: released.id } });
    expect(after.rows.find(row => row.cells.recordType?.value === "BANK_ACTUAL")?.cells.remaining?.value).toBe("0.03");
    expect(await snapshot(f)).toEqual(before);
    await expect(prepareAccountantExport(actor, { ...query, accountId: randomUUID() }, source => source, { db })).rejects.toThrow(AccountantExportAccessError);
  });
});
