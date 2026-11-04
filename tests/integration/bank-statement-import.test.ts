import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant, type TenantTransaction } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";
import { reviewBankStatement, importBankStatement, recoverBankStatement } from "@/modules/finance/application/bank-statement-import";
import { requestBankStatementCommand, recoverBankStatementCommand, bankStatementCommandStatus } from "@/modules/finance/application/bank-statement-command";
import { reviewGuestDepositReceipt, postGuestDepositReceipt } from "@/modules/finance/application/guest-deposit-service";
import { BankStatementRepository } from "@/modules/finance/infrastructure/bank-statement-repository";
import { readBankStatementWorkspace } from "@/modules/finance/application/bank-statement-workspace";
import { bankStatementAccountsSchema, bankStatementDetailSchema, bankStatementListSchema } from "@/modules/finance/domain/bank-statement-workspace";
import { BankStatementAccessError, BankStatementConflictError, BankStatementStorageError, BankStatementValidationError } from "@/modules/finance/domain/bank-statement-import";
import * as auditWriter from "@/platform/audit/audit-writer";
import { actualGuestDepositFixture } from "./support/guest-deposit-fixture";
import { provisionIntegrationRole } from "./support/database-role";
import { transactionQueryMeasurement } from "./support/transaction-query-measurement";

const url = process.env.TEST_DATABASE_URL;
let admin: PrismaClient, db: PrismaClient, queryMeasurement: ReturnType<typeof transactionQueryMeasurement>;
beforeAll(async () => {
  const target = url ? new URL(url) : null;
  if (!target || !["127.0.0.1", "localhost"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Dedicated bank statement acceptance database required");
  execFileSync(process.execPath, ["node_modules/prisma/build/index.js", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const scoped = new URL(url!); scoped.username = "alvillas_ops_tests"; scoped.password = "alvillas_ops_tests";
  const observed = new PrismaClient({ datasourceUrl: scoped.toString(), log: [{ emit: "event", level: "query" }] });
  queryMeasurement = transactionQueryMeasurement(observed); observed.$on("query", event => queryMeasurement.observe(event.query)); db = observed;
});
afterAll(async () => { await db?.$disconnect(); await admin?.$disconnect(); });

async function fixture(withBankIds = true) {
  const f = await actualGuestDepositFixture(db, admin), objects = new Map<string, Uint8Array>();
  const policy = bankStatementPolicySchema.parse({ source: "ORIGINAL_BANK_STATEMENT", accounts: [{ account_code: f.banks.receipt.code,
    bank_id: "actual-bank", branch_id: null, account_id: "actual-account-1234", account_type: "CHECKING", currency: "MAD", ofx: true,
    csv: { delimiter: ";", dateFormat: "YYYY-MM-DD", decimalSeparator: ".", groupingSeparator: "", columns: { postedDate: "date", transactionId: withBankIds ? "id" : null,
      reference: "reference", description: "description", currency: "currency", amount: "amount" } } }], encoding: "UTF-8", max_bytes: 1000000, max_rows: 5000,
    matching: { date_window_days: 0, amount_tolerance: "0.00", reference: "EXACT", admission: "EXPLICIT_REVIEW", ledger_effect: "NONE" },
    source_corrections: "APPEND_AND_REOPEN_REVIEW", duplicate_csv_without_id: "RETAIN_EVERY_ROW" });
  const writeGrant = await withTenant(db, f.org, async tx => {
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: ["bank_statement:view", "bank_statement:create", "bank_statement:reconcile", "bank_statement:export"] } } });
    expect(permissions).toHaveLength(4);
    await tx.rolePermission.createMany({ data: permissions.filter(permission => permission.key !== "bank_statement:create").map(permission => ({ organizationId: f.org, roleId: f.role.id, permissionId: permission.id })) });
    const writeRole = await tx.role.create({ data: { organizationId: f.org, key: "actual_bank_import_writer", name: "Independent original bank admission authority" } });
    await tx.rolePermission.create({ data: { organizationId: f.org, roleId: writeRole.id, permissionId: permissions.find(permission => permission.key === "bank_statement:create")!.id } });
    const grant = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: writeRole.id, userAccountId: f.account.id, personId: f.person.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
    await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id, value: policy, reason: "Explicit actual bank identity, original export mapping and independent matching policy" });
    return grant;
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
  const storage = {
    createSignedUploadUrl: ({ key }: { key: string; contentType: string }) => Promise.resolve({ url: "https://bank-storage.example.test/" + encodeURIComponent(key) }),
    createSignedDownloadUrl: ({ key }: { key: string; expiresInSeconds: number }) => Promise.resolve({ url: "https://bank-storage.example.test/" + encodeURIComponent(key) })
  };
  const state = { corruptRead: false, putAttempts: 0, writes: 0 };
  const transport: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== "https://bank-storage.example.test") throw Error("Test storage never accesses a network service");
    const key = decodeURIComponent(target.pathname.slice(1));
    if (init?.method === "PUT") {
      state.putAttempts++;
      expect(new Headers(init.headers).get("If-None-Match")).toBe("*");
      if (objects.has(key)) return new Response(null, { status: 412 });
      objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer())); state.writes++;
      return new Response(null, { status: 200 });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(state.corruptRead ? new Uint8Array([1]) : new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
  };
  const bytes = new TextEncoder().encode("Date;ID;Reference;Description;Amount;Currency\n2026-11-03;bank-1;same-reference;Actual receipt;0.07;MAD\n2026-11-03;bank-2;same-reference;Actual charge;-0.01;MAD");
  const input = { accountId: f.banks.receipt.id, format: "CSV" as const, fileSha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength };
  return { ...f, ctx, policy, bytes, input, storage, transport, state, objects, writeGrant, deps: { db, storage, transport } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function command(f: Fixture, bytes = f.bytes, format: "CSV" | "OFX" = "CSV") {
  const source = { ...f.input, format, fileSha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength };
  const reviewed = await reviewBankStatement(f.ctx, source, bytes, f.deps);
  return { ...source, reviewFingerprint: String(reviewed.reviewFingerprint), idempotencyKey: randomUUID(), reason: "Admit and retain the actual original bank export" };
}
const money = (f: Fixture) => withTenant(db, f.org, tx => tx.$queryRaw`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'audit',id::text,xmin::text,to_jsonb(a) FROM audit_log a WHERE organization_id=${f.org}::uuid AND action NOT LIKE 'finance.bank_statement.%' ORDER BY kind,id`);
const counts = (f: Fixture) => withTenant(db, f.org, async tx => ({ admissions: await tx.bankStatementAdmission.count(), imports: await tx.bankStatementImport.count(), lines: await tx.bankStatementLine.count(), evidence: await tx.bankStatementEvidence.count() }));
const convertedSource = (rate = "10.250000") => new TextEncoder().encode(`<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>MAD</CURDEF><BANKACCTFROM><BANKID>actual-bank</BANKID><ACCTID>actual-account-1234</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20261103</DTSTART><DTEND>20261103</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>0.07</TRNAMT><FITID>converted-original</FITID><NAME>Actual bank-converted receipt</NAME><ORIGCURRENCY><CURSYM>EUR</CURSYM><CURRATE>${rate}</CURRATE></ORIGCURRENCY></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>0.07</BALAMT><DTASOF>20261103</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`);

describe("actual immutable bank statement admission", () => {
  it("retains independent bank-reported currency evidence for every original import without converting or rewriting Money", async () => {
    const f = await fixture(), received = await reviewGuestDepositReceipt(f.ctx, f.receiptInput, { db });
    await postGuestDepositReceipt(f.ctx, { ...f.receiptInput, reviewFingerprint: received.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Receive actual original bank funds before converted-source evidence" }, { db });
    const before = await money(f), firstBytes = convertedSource(), first = await importBankStatement(f.ctx, await command(f, firstBytes, "OFX"), firstBytes, f.deps);
    const firstDetail = bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: first.importId }, f.deps));
    expect(firstDetail.lines).toHaveLength(1);
    expect(firstDetail.lines[0]).toMatchObject({ fact: { amount: { amount: "0.07", currency: "MAD" } }, currencyEvidence: { kind: "BANK_CONVERTED", currency: "EUR", rate: "10.250000" } });
    const originalLines = await withTenant(db, f.org, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(l) AS body FROM bank_statement_line l ORDER BY id`);
    const nextBytes = convertedSource("10.260000"), second = await importBankStatement(f.ctx, await command(f, nextBytes, "OFX"), nextBytes, f.deps);
    expect(second).toMatchObject({ newRows: 0, reusedRows: 1 });
    const secondDetail = bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: second.importId }, f.deps));
    expect(secondDetail.lines[0]).toMatchObject({ id: firstDetail.lines[0].id, fact: { amount: { amount: "0.07", currency: "MAD" } }, currencyEvidence: { rate: "10.260000" } });
    expect(bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: first.importId }, f.deps)).lines).toEqual(firstDetail.lines);
    expect(await withTenant(db, f.org, tx => tx.$queryRaw`SELECT id::text,xmin::text,to_jsonb(l) AS body FROM bank_statement_line l ORDER BY id`)).toEqual(originalLines);
    expect(await money(f)).toEqual(before); expect(f.objects.size).toBe(2); expect([...f.objects.values()]).toEqual([firstBytes, nextBytes]);
  });
  it("recovers the original bank-converted command after a retained storage failure", async () => {
    const f = await fixture(), bytes = convertedSource(), input = await command(f, bytes, "OFX");
    await expect(importBankStatement(f.ctx, input, bytes, { ...f.deps, transport: () => Promise.resolve(new Response(null, { status: 503 })) })).rejects.toBeInstanceOf(BankStatementStorageError);
    expect(await counts(f)).toEqual({ admissions: 1, imports: 0, lines: 0, evidence: 0 });
    const recovered = await recoverBankStatement(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps);
    expect(recovered).toMatchObject({ state: "ADMITTED", resumeInput: input });
    const result = await importBankStatement(f.ctx, input, bytes, f.deps);
    expect(result).toMatchObject({ state: "IMPORTED", rowCount: 1 });
    expect(bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: result.importId }, f.deps)).lines[0]).toMatchObject({ currencyEvidence: { currency: "EUR", rate: "10.250000" } });
  });
  it("rejects an unconverted foreign amount before creating an admission or storing original bytes", async () => {
    const f = await fixture(), bytes = new TextEncoder().encode(new TextDecoder().decode(convertedSource()).replaceAll("ORIGCURRENCY", "CURRENCY"));
    const source = { ...f.input, format: "OFX", fileSha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength };
    await expect(reviewBankStatement(f.ctx, source, bytes, f.deps)).rejects.toBeInstanceOf(BankStatementValidationError);
    expect(await counts(f)).toEqual({ admissions: 0, imports: 0, lines: 0, evidence: 0 }); expect(f.objects.size).toBe(0);
  });
  it("retains original bytes, signed source facts and atomic audit without writing any financial movement", async () => {
    const f = await fixture(), reviewed = await reviewGuestDepositReceipt(f.ctx, f.receiptInput, { db });
    await postGuestDepositReceipt(f.ctx, { ...f.receiptInput, reviewFingerprint: reviewed.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Actual original bank receipt before statement admission" }, { db });
    const before = await money(f), result = await importBankStatement(f.ctx, await command(f), f.bytes, f.deps);
    expect(result).toMatchObject({ state: "IMPORTED", rowCount: 2, newRows: 2, reusedRows: 0 });
    expect(await counts(f)).toEqual({ admissions: 1, imports: 1, lines: 2, evidence: 2 });
    const rows = await withTenant(db, f.org, tx => tx.bankStatementLine.findMany({ orderBy: { externalId: "asc" } }));
    expect(rows.map(row => row.amount?.toFixed(2))).toEqual(["0.07", "-0.01"]);
    expect([...f.objects.values()]).toEqual([f.bytes]); expect(await money(f)).toEqual(before);
  });
  it("recovers the actor-bound original result and rejects changed intent without another upload", async () => {
    const f = await fixture(), input = await command(f), first = await importBankStatement(f.ctx, input, f.bytes, f.deps);
    expect(await importBankStatement(f.ctx, input, f.bytes, f.deps)).toEqual(first);
    expect(await recoverBankStatement(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toEqual(first);
    await expect(importBankStatement(f.ctx, { ...input, reason: "Changed later import intention" }, f.bytes, f.deps)).rejects.toBeInstanceOf(BankStatementConflictError);
    expect(f.state.writes).toBe(1); expect(f.state.putAttempts).toBe(1);
  });
  it("associates a repeated file with the original bank facts while retaining both import receipts", async () => {
    const f = await fixture(); await importBankStatement(f.ctx, await command(f), f.bytes, f.deps);
    const original = await withTenant(db, f.org, tx => tx.$queryRaw`SELECT id,xmin::text,to_jsonb(l) AS body FROM bank_statement_line l ORDER BY id`);
    const reviewed = await reviewBankStatement(f.ctx, f.input, f.bytes, f.deps);
    expect(reviewed).toMatchObject({ newRows: 0, reusedRows: 2 });
    expect(await importBankStatement(f.ctx, await command(f), f.bytes, f.deps)).toMatchObject({ newRows: 0, reusedRows: 2 });
    expect(await counts(f)).toEqual({ admissions: 2, imports: 2, lines: 2, evidence: 4 });
    expect(await withTenant(db, f.org, tx => tx.$queryRaw`SELECT id,xmin::text,to_jsonb(l) AS body FROM bank_statement_line l ORDER BY id`)).toEqual(original);
  });
  it("retains identical CSV rows without conflating their ordinary reference with a bank transaction ID", async () => {
    const f = await fixture(false), bytes = new TextEncoder().encode("Date;ID;Reference;Description;Amount;Currency\n2026-11-03;;same;Actual repeated receipt;0.01;MAD\n2026-11-03;;same;Actual repeated receipt;0.01;MAD");
    await importBankStatement(f.ctx, await command(f, bytes), bytes, f.deps);
    const rows = await withTenant(db, f.org, tx => tx.bankStatementLine.findMany());
    expect(rows).toHaveLength(2); expect(new Set(rows.map(row => row.identityHash)).size).toBe(2);
    expect(rows.every(row => row.externalId === null)).toBe(true);
  });
  it("retains durable admission during a storage failure and completes the same request after verified recovery", async () => {
    const f = await fixture(), input = await command(f), before = await money(f); f.state.corruptRead = true;
    await expect(importBankStatement(f.ctx, input, f.bytes, f.deps)).rejects.toBeInstanceOf(BankStatementStorageError);
    expect(await recoverBankStatement(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toMatchObject({ state: "ADMITTED", importId: null, resumeInput: input });
    expect(await counts(f)).toEqual({ admissions: 1, imports: 0, lines: 0, evidence: 0 });
    f.state.corruptRead = false;
    expect(await importBankStatement(f.ctx, input, f.bytes, f.deps)).toMatchObject({ state: "IMPORTED", rowCount: 2 });
    expect(f.state.writes).toBe(1); expect(await money(f)).toEqual(before);
  });
  it("serializes concurrent requests against one actual admission and original source fact set", async () => {
    const f = await fixture(), input = await command(f);
    const results = await Promise.all([importBankStatement(f.ctx, input, f.bytes, f.deps), importBankStatement(f.ctx, input, f.bytes, f.deps)]);
    expect(results[0]).toEqual(results[1]); expect(f.state.writes).toBe(1);
    expect(await counts(f)).toEqual({ admissions: 1, imports: 1, lines: 2, evidence: 2 });
  });
  it("isolates actual source rows across tenants and prevents source history mutation", async () => {
    const f = await fixture(), other = await fixture(); await importBankStatement(f.ctx, await command(f), f.bytes, f.deps);
    const row = await withTenant(db, f.org, tx => tx.bankStatementLine.findFirstOrThrow());
    expect(await withTenant(db, other.org, tx => tx.bankStatementLine.findMany({ where: { id: row.id } }))).toEqual([]);
    await expect(withTenant(db, f.org, tx => tx.bankStatementLine.update({ where: { id: row.id }, data: { amount: "1.00" } }))).rejects.toThrow();
    await expect(withTenant(db, f.org, tx => tx.bankStatementLine.delete({ where: { id: row.id } }))).rejects.toThrow();
    await expect(recoverBankStatement(other.ctx, { idempotencyKey: randomUUID() }, other.deps)).rejects.toBeInstanceOf(BankStatementAccessError);
  });
  it("rolls back the complete import if original source view is revoked at its final audit boundary", async () => {
    const f = await fixture(), input = await command(f), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await original(tx, event);
      if (event.organizationId === f.org && event.action === "finance.bank_statement.imported") await (tx as unknown as TenantTransaction).roleAssignment.updateMany({ where: { organizationId: f.org, userAccountId: f.account.id }, data: { archivedAt: new Date() } });
      return result;
    });
    try { await expect(importBankStatement(f.ctx, input, f.bytes, f.deps)).rejects.toBeInstanceOf(BankStatementAccessError); }
    finally { spy.mockRestore(); }
    expect(await counts(f)).toEqual({ admissions: 1, imports: 0, lines: 0, evidence: 0 });
    expect(await recoverBankStatement(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toMatchObject({ state: "ADMITTED" });
  });
  it("requires the actual atomic imported audit at the PostgreSQL boundary", async () => {
    const f = await fixture(), input = await command(f), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => event.organizationId === f.org && event.action === "finance.bank_statement.imported" ? undefined : original(tx, event));
    try { await expect(importBankStatement(f.ctx, input, f.bytes, f.deps)).rejects.toThrow(/atomic admission audit/u); }
    finally { spy.mockRestore(); }
    expect(await counts(f)).toEqual({ admissions: 1, imports: 0, lines: 0, evidence: 0 });
  });
  it("rejects a forged source amount even when application parsing is bypassed", async () => {
    const f = await fixture(), input = await command(f), original = Object.getOwnPropertyDescriptor(BankStatementRepository.prototype, "complete")!.value as BankStatementRepository["complete"];
    const spy = vi.spyOn(BankStatementRepository.prototype, "complete").mockImplementation(function (this: BankStatementRepository, admission, parsed, currency, hash) {
      return original.call(this, admission, { ...parsed, lines: parsed.lines.map((row, index) => index ? row : { ...row, fact: { ...row.fact, amount: { amount: "0.08", currency: "MAD" } } }) }, currency, hash);
    });
    try { await expect(importBankStatement(f.ctx, input, f.bytes, f.deps)).rejects.toThrow(/atomic admission audit/u); }
    finally { spy.mockRestore(); }
    expect(await counts(f)).toEqual({ admissions: 1, imports: 0, lines: 0, evidence: 0 });
  });
  it("reads private source history after admission authority ends while independently denying another import", async () => {
    const f = await fixture(), input = await command(f), result = await importBankStatement(f.ctx, input, f.bytes, f.deps);
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: f.writeGrant.id }, data: { archivedAt: new Date() } }));
    const accounts = bankStatementAccountsSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "ACCOUNTS" }, f.deps));
    expect(accounts.items).toHaveLength(1); expect(accounts.items[0].canImport).toBe(false);
    const list = bankStatementListSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "LIST", accountId: f.banks.receipt.id }, f.deps));
    expect(list.items.map(row => row.id)).toEqual([result.importId]);
    const detail = bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: result.importId }, f.deps));
    expect(detail.lines.map(row => row.fact.amount?.amount)).toEqual(["0.07", "-0.01"]);
    expect(await recoverBankStatement(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).toMatchObject(result);
    await expect(importBankStatement(f.ctx, { ...input, idempotencyKey: randomUUID() }, f.bytes, f.deps)).rejects.toBeInstanceOf(BankStatementAccessError);
  });
  it("retains every source row beyond ten history pages with a constant page query count", async () => {
    const f = await fixture(), bytes = new TextEncoder().encode("Date;ID;Reference;Description;Amount;Currency\n" + Array.from({ length: 501 }, (_, index) => `2026-11-03;large-${index};ref-${index};Actual original ${index};0.01;MAD`).join("\n"));
    const result = await importBankStatement(f.ctx, await command(f, bytes), bytes, f.deps), ids = new Set<string>(), pageQueries: number[] = [];
    let afterOrder: number | undefined;
    do {
      const measured = await queryMeasurement.measure(() => readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: result.importId, ...(afterOrder ? { afterOrder } : {}) }, f.deps));
      const page = bankStatementDetailSchema.parse(measured.value);
      pageQueries.push(measured.count);
      for (const row of page.lines) { expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
      afterOrder = page.nextOrder ?? undefined;
    } while (afterOrder !== undefined);
    expect(ids.size).toBe(501); expect(pageQueries).toHaveLength(11); expect(new Set(pageQueries).size).toBe(1);
    console.log(JSON.stringify({ bankHistoryRows: ids.size, pages: pageQueries.length, queriesPerPage: pageQueries[0] }));
  });
  it("rechecks current source view after the final history audit and rolls back the undisclosed read", async () => {
    const f = await fixture(), result = await importBankStatement(f.ctx, await command(f), f.bytes, f.deps), original = auditWriter.writeAuditEvent;
    const before = await withTenant(db, f.org, tx => tx.auditLog.count());
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const written = await original(tx, event);
      if (event.organizationId === f.org && event.action === "finance.bank_statement.detail_viewed") await (tx as unknown as TenantTransaction).roleAssignment.updateMany({ where: { organizationId: f.org, userAccountId: f.account.id }, data: { archivedAt: new Date() } });
      return written;
    });
    try { await expect(readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: result.importId }, f.deps)).rejects.toBeInstanceOf(BankStatementAccessError); }
    finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.auditLog.count())).toBe(before);
  });
  it("denies a substituted actual source bank before retaining any upload or admission", async () => {
    const f = await fixture(), input = await command(f);
    await expect(importBankStatement(f.ctx, { ...input, accountId: f.banks.refund.id }, f.bytes, f.deps)).rejects.toThrow();
    expect(await counts(f)).toEqual({ admissions: 0, imports: 0, lines: 0, evidence: 0 }); expect(f.state.putAttempts).toBe(0);
  });
  it("returns exact private public-command receipts for accepted uploads, original recovery and status", async () => {
    const f = await fixture(), input = await command(f); f.state.corruptRead = true;
    await expect(requestBankStatementCommand(f.ctx, input, f.bytes, f.deps)).rejects.toBeInstanceOf(BankStatementStorageError);
    const pending = await recoverBankStatementCommand(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps);
    expect(pending.request).toMatchObject({ state: "PENDING", idempotencyKey: input.idempotencyKey, resumeInput: input });
    expect(await bankStatementCommandStatus(f.ctx, { id: pending.request!.requestId }, f.deps)).toEqual(pending.request);
    f.state.corruptRead = false; const result = await requestBankStatementCommand(f.ctx, input, f.bytes, f.deps);
    expect(result).toMatchObject({ state: "SUCCEEDED", accountId: f.banks.receipt.id, rowCount: 2, idempotencyKey: input.idempotencyKey });
    expect((await recoverBankStatementCommand(f.ctx, { idempotencyKey: input.idempotencyKey }, f.deps)).request).toEqual(result);
    expect(await bankStatementCommandStatus(f.ctx, { id: result.requestId }, f.deps)).toEqual(result);
    expect(await recoverBankStatementCommand(f.ctx, { idempotencyKey: randomUUID() }, f.deps)).toEqual({ request: null });
  });
  it("retains independently visible source history after the bank is archived and its current import binding is replaced", async () => {
    const f = await fixture(), result = await importBankStatement(f.ctx, await command(f), f.bytes, f.deps);
    await withTenant(db, f.org, async tx => {
      await tx.ledgerAccount.update({ where: { id: f.banks.receipt.id }, data: { archivedAt: new Date() } });
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: new Date(), createdBy: f.account.id,
        value: { ...f.policy, accounts: [{ ...f.policy.accounts[0], account_code: f.banks.refund.code, account_id: "replacement-account" }] }, reason: "Retire the original bank import binding while retaining every original source" });
    });
    const accounts = bankStatementAccountsSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "ACCOUNTS" }, f.deps));
    expect(accounts.items.find(account => account.id === f.banks.receipt.id)).toMatchObject({ canImport: false, lastFour: "1234" });
    const detail = bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: result.importId }, f.deps));
    expect(detail.lines).toHaveLength(2); expect(detail.account.lastFour).toBe("1234");
  });
  it("rejects malformed source dates, precision and encodings before admitting or uploading a request", async () => {
    const f = await fixture();
    const invalid = [new TextEncoder().encode("Date;ID;Reference;Description;Amount;Currency\n2026-02-30;bad;r;Invalid calendar;0.01;MAD"),
      new TextEncoder().encode("Date;ID;Reference;Description;Amount;Currency\n2026-11-03;bad;r;Inexact amount;0.001;MAD"), new Uint8Array([255]), new TextEncoder().encode("null\u0000source")];
    for (const bytes of invalid) {
      const input = { ...f.input, fileSha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength };
      await expect(reviewBankStatement(f.ctx, input, bytes, f.deps)).rejects.toBeInstanceOf(BankStatementValidationError);
    }
    expect(await counts(f)).toEqual({ admissions: 0, imports: 0, lines: 0, evidence: 0 }); expect(f.state.putAttempts).toBe(0);
  });
  it("retains an original zero-movement export as evidence without inventing a source movement or balance", async () => {
    const f = await fixture(), bytes = new TextEncoder().encode("Date;ID;Reference;Description;Amount;Currency\n");
    const result = await importBankStatement(f.ctx, await command(f, bytes), bytes, f.deps);
    expect(result).toMatchObject({ state: "IMPORTED", rowCount: 0, newRows: 0, reusedRows: 0 });
    expect(await counts(f)).toEqual({ admissions: 1, imports: 1, lines: 0, evidence: 0 });
    const detail = bankStatementDetailSchema.parse(await readBankStatementWorkspace(f.ctx, { operation: "DETAIL", importId: result.importId }, f.deps));
    expect(detail.lines).toEqual([]); expect(detail.nextOrder).toBeNull(); expect([...f.objects.values()]).toEqual([bytes]);
  });
});
