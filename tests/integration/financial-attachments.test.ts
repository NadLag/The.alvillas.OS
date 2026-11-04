import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { captureAuthorizationCap, restoreAuthorizationCap } from "@/platform/authz/authorization-cap";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { FinancialAttachmentObjectStore } from "@/modules/finance/infrastructure/financial-attachment-storage";
import { admitFinancialAttachment, uploadFinancialAttachment, readFinancialAttachments, downloadFinancialAttachment, readFinancialAttachmentEditor } from "@/modules/finance/application/financial-attachments";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { financialAttachmentPolicyKey } from "@/modules/finance/domain/financial-attachment-policy";
import { listAuditHistory, exportAuditHistoryCsv } from "@/modules/audit/application/audit-service";
import { Money } from "@/platform/money/money";
import { hashRateLimitKey } from "@/platform/rate-limit/postgres-rate-limiter";
import * as auditWriter from "@/platform/audit/audit-writer";
import { maskedValue } from "@/platform/authz/present";
import { employeePercentageFixtures } from "./support/employee-percentage";
import { createEmployeePercentageCompensationRun } from "@/modules/finance/application/employee-percentage-run-service";
import { submitEmployeeCompensation, getEmployeeCompensationSubmission } from "@/modules/finance/application/employee-compensation-submission";
import { recognizeEmployeeCompensation } from "@/modules/finance/application/employee-compensation-recognition";
import { decideApproval } from "@/platform/approvals/approval-service";
import { createCompanyExpensePlan } from "@/modules/finance/application/company-expense-service";
import { changeCompanyExpenseCompensationSource } from "@/modules/finance/application/company-expense-compensation-service";

const url = process.env.TEST_DATABASE_URL; let admin: PrismaClient, db: PrismaClient, server: Server, storageUrl: string;
const objects = new Map<string, Buffer>(), env: NodeJS.ProcessEnv = { NODE_ENV: "test", ENCRYPTION_KEYS: "native:" + randomBytes(32).toString("base64") };
const content = (label = "Original receipt") => Buffer.from("%PDF-1.7\n" + label + "\n%%EOF\n"), hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const objectStore = (transport: typeof fetch = fetch) => new FinancialAttachmentObjectStore({
  createSignedUploadUrl: ({ key }) => Promise.resolve({ url: storageUrl + "/" + key }),
  createSignedDownloadUrl: ({ key }) => Promise.resolve({ url: storageUrl + "/" + key }) }, transport, env);
beforeAll(async () => {
  if (!url || !["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw Error("Local PostgreSQL is required");
  admin = new PrismaClient({ datasourceUrl: url }); await provisionIntegrationRole(admin, "alvillas_ops_tests");
  const scoped = new URL(url); scoped.username = scoped.password = "alvillas_ops_tests"; db = new PrismaClient({ datasourceUrl: scoped.toString() });
  server = createServer((request, response) => { void (async () => {
    const key = request.url!;
    if (request.method === "PUT") {
      if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end(); return; }
      const chunks: Buffer[] = []; for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
      if (objects.has(key)) { response.writeHead(412).end(); return; } objects.set(key, Buffer.concat(chunks)); response.writeHead(200).end(); return;
    }
    const original = objects.get(key); if (!original) response.writeHead(404).end(); else response.writeHead(200, { "content-length": original.length }).end(original);
  })().catch(() => response.destroy()); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address();
  if (!address || typeof address === "string") throw Error("Dedicated local object transport required"); storageUrl = "http://127.0.0.1:" + address.port;
});
afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); await admin?.$disconnect(); if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });

const policy = (requests = 100) => ({ source: "ORIGINAL_SEALED_FINANCIAL_TRANSACTION", content_types: ["application/pdf", "image/png"], max_bytes: 1048576,
  intent_lifetime_seconds: 600, storage_read_ttl_seconds: 30, encryption: "APP_MANAGED_AUTHENTICATED_ENCRYPTION", history: "APPEND_ONLY_WITH_RETAINED_SUPERSEDED_FILES",
  rate_limit: { requests, window_seconds: 3600 } });
async function fixture(requests = 100, multicurrency = false) {
  const org = randomUUID(); await admin.organization.create({ data: { id: org, name: "Dedicated original attachment acceptance", baseCurrency: "MAD" } }); await ensureStandardIdentitySetup(org, { db });
  return withTenant(db, org, async tx => {
    for (const code of ["MAD", ...(multicurrency ? ["EUR"] : [])]) await tx.currency.upsert({ where: { code }, update: {}, create: { code, name: code, minorUnit: 2 } });
    const person = await tx.person.create({ data: { organizationId: org, displayName: "Dedicated receipt author" } }), account = await tx.userAccount.create({ data: { organizationId: org, personId: person.id } });
    const property = await tx.property.create({ data: { organizationId: org, name: "Dedicated receipt villa", addressLine1: "Local native acceptance", city: "Marrakech", propertyType: "VILLA", bedrooms: 1, bathrooms: 1, maxGuests: 2, amenities: [], photoUrls: [] } });
    const finance = new FinanceRepository(tx, org), bank = await finance.ensureLedgerAccount({ code: "BANK_RECEIPTS", name: "Dedicated native receipt bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
      claim = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Dedicated native receipt claim", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
    const dimensions = { property_id: property.id }, postings = [{ ledgerAccountId: bank.id, side: "DEBIT" as const, amount: Money.of("9007199254740993.07", "MAD"), bucket: "OWNER_REVENUE", dimensions },
      { ledgerAccountId: claim.id, side: "CREDIT" as const, amount: Money.of("9007199254740993.07", "MAD"), bucket: "OWNER_REVENUE", dimensions }];
    if (multicurrency) postings.push({ ledgerAccountId: bank.id, side: "DEBIT", amount: Money.of("0.03", "EUR"), bucket: "OWNER_REVENUE", dimensions }, { ledgerAccountId: claim.id, side: "CREDIT", amount: Money.of("0.03", "EUR"), bucket: "OWNER_REVENUE", dimensions });
    const journal = await finance.createFinancialTransaction({ reference: "ATTACHMENT:" + randomUUID(), description: "Actual original financial document source", idempotencyKey: randomUUID(), occurredAt: new Date("2032-05-01T12:00:00Z"), createdBy: account.id, postings });
    await new ConfigRuleRepository(tx, org).createVersion({ key: financialAttachmentPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: account.id, value: policy(requests), reason: "Explicit original-file native admission policy" });
    return { org, property, journal };
  });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function actor(f: Pick<Fixture, "org">, options: { keys?: string[]; propertyId?: string; recordId?: string; cap?: string } = {}) {
  const identity = await withTenant(db, f.org, async tx => {
    const person = await tx.person.create({ data: { organizationId: f.org, displayName: "Dedicated document reader" } }), account = await tx.userAccount.create({ data: { organizationId: f.org, personId: person.id } }),
      role = await tx.role.create({ data: { organizationId: f.org, key: "receipt_" + randomUUID(), name: "Dedicated native receipt grants" } });
    const keys = options.keys ?? ["financial_transaction:view", "financial_transaction:export", "financial_attachment:view", "financial_attachment:create", "financial_attachment:export", "audit_log:view", "audit_log:export"];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.map(permission => ({ organizationId: f.org, roleId: role.id, permissionId: permission.id })) });
    const assignment = await tx.roleAssignment.create({ data: { organizationId: f.org, userAccountId: account.id, personId: person.id, roleId: role.id,
      scopeType: options.recordId ? "financial_record" : options.propertyId ? "property" : "organization", scopeId: options.recordId ?? options.propertyId ?? null, validFrom: new Date("2020-01-01"), ...(options.cap ? { conditions: { maxAmount: options.cap } } : {}) } });
    return { person, account, role, assignment };
  });
  return { organizationId: f.org, actorId: identity.account.id, personId: identity.person.id, authContext: { ...await authContextForAccount(f.org, identity.account.id, { db }), personId: identity.person.id }, ...identity };
}
const input = (f: Fixture, bytes = content(), extras = {}) => ({ transactionId: f.journal.id, idempotencyKey: randomUUID(), kind: "RECEIPT", fileName: "إيصال-original.pdf", contentType: "application/pdf", fileSize: bytes.length, sha256: hash(bytes), reason: "Dedicated original financial source evidence", ...extras });
async function attach(f: Fixture, owner: Awaited<ReturnType<typeof actor>>, bytes = content(), extras = {}) {
  const admission = await admitFinancialAttachment(owner, input(f, bytes, extras), { db }); return uploadFinancialAttachment(owner, { id: admission.id }, bytes, { db, objects: objectStore() });
}
async function financialXmins(f: Fixture) { return withTenant(db, f.org, tx => tx.$queryRaw<{ kind: string; id: string; xmin: string }[]>`
  SELECT 'journal' AS kind,id::text,xmin::text FROM financial_transaction WHERE organization_id=${f.org}::uuid
  UNION ALL SELECT 'posting',id::text,xmin::text FROM posting WHERE organization_id=${f.org}::uuid ORDER BY kind,id`); }

describe("native immutable transaction receipts and invoices", () => {
  it("keeps journal-scoped document grants usable across original and corrected file identities", async () => {
    const f = await fixture(), scoped = await actor(f, { recordId: f.journal.id }), original = await attach(f, scoped), correction = await attach(f, scoped, content("Scoped correction"), { supersedesId: original.id });
    expect(correction.rootId).toBe(original.id); expect((await readFinancialAttachments(scoped, { transactionId: f.journal.id }, { db })).items).toHaveLength(2);
    expect((await downloadFinancialAttachment(scoped, { id: original.id }, { db, objects: objectStore() })).bytes).toEqual(content());
  });
  it("replays a completed file after a policy update without replacing original storage or metadata", async () => {
    const f = await fixture(), owner = await actor(f), command = input(f), admission = await admitFinancialAttachment(owner, command, { db }), saved = await uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() });
    const retained = await withTenant(db, f.org, tx => tx.financialAttachment.findUniqueOrThrow({ where: { id: saved.id } }));
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: financialAttachmentPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: owner.actorId,
      value: { ...policy(), max_bytes: 2048 }, reason: "Explicit policy update after original file completion" }));
    expect(await uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() })).toEqual(saved);
    expect(await admitFinancialAttachment(owner, command, { db })).toMatchObject({ id: admission.id, attached: true });
    expect(await withTenant(db, f.org, tx => tx.financialAttachment.findUniqueOrThrow({ where: { id: saved.id } }))).toEqual(retained);
  });
  it.each(["finance.financial_attachment.attached", "finance.financial_attachment.downloaded"])("fences policy changes while the final %s audit is written", async action => {
    const f = await fixture(), owner = await actor(f), admission = await admitFinancialAttachment(owner, input(f), { db });
    if (action.endsWith("downloaded")) await uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() });
    const original = auditWriter.writeAuditEvent; let changed = false;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => {
      const result = await original(tx, event); if (!changed && event.action === action) { changed = true;
        await withTenant(db, f.org, other => new ConfigRuleRepository(other, f.org).createVersion({ key: financialAttachmentPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: owner.actorId,
          value: { ...policy(), max_bytes: 2048 }, reason: "Explicit policy change during final file audit" })); } return result;
    });
    try { await expect(action.endsWith("attached") ? uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() })
      : downloadFinancialAttachment(owner, { id: admission.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_conflict"); } finally { spy.mockRestore(); }
    expect(changed).toBe(true); expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: admission.id, action } }))).toBe(0);
    expect(await withTenant(db, f.org, tx => tx.financialAttachment.count())).toBe(action.endsWith("downloaded") ? 1 : 0);
  });
  it("retains original salary and earned-source restrictions on actual approved employee journals and their file audit", async () => {
    const fixtures = employeePercentageFixtures(() => db, () => admin), f = await fixtures.financialFixture(), base = await fixtures.posting(f, { dimensions: {} }),
      run = await createEmployeePercentageCompensationRun(f.actor, fixtures.input(f, [base.source.id]), { db }), now = await withTenant(db, f.org, tx => new FinanceRepository(tx, f.org).clock());
    const submission = await submitEmployeeCompensation(f.actor, { runId: run.id, costOn: now.toISOString().slice(0,10), emergency: false, idempotencyKey: randomUUID(),
      reason: "Submit original salary document financial sources", costs: run.lines.map(line => ({ runLineId: line.id, category: "salary", costCenter: "document_staff", note: "Actual original salary document source" })) }, { db });
    const stages = await withTenant(db, f.org, tx => tx.approvalStage.findMany({ where: { approvalId: submission.approvalId! }, orderBy: { position: "asc" } })); expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) await decideApproval({ organizationId: f.org, accountId: f.actor.actorId, authContext: f.actor.authContext }, { id: submission.approvalId!, stageId: stage.id, decision: "APPROVED", reason: "Approve original salary document sources" }, { db });
    const claimId = (await getEmployeeCompensationSubmission(f.actor, { id: submission.id }, { db })).costs[0].claimId,
      recognition = await recognizeEmployeeCompensation(f.actor, { id: submission.id, claimId, idempotencyKey: randomUUID(), currentPeriod: false, reason: "Recognize original approved salary for private document acceptance" }, { db }),
      owner = await actor(f, { keys: ["financial_transaction:view", "financial_transaction:export", "financial_attachment:view", "financial_attachment:create", "financial_attachment:export", "audit_log:view", "audit_log:export", "staff_compensation:view", "employee_payable:view", "expense:view", "company_expense:view", "company_expense:create", "company_expense:edit"] }), financier = await actor(f), bytes = content("Actual earned staff compensation receipt");
    await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: financialAttachmentPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: owner.actorId, value: policy(), reason: "Explicit original salary attachment policy" }));
    const command = { transactionId: recognition.transactionIds[0], idempotencyKey: randomUUID(), kind: "RECEIPT", fileName: "private-earned-staff-receipt.pdf", contentType: "application/pdf", fileSize: bytes.length, sha256: hash(bytes), reason: "Actual original staff financial receipt" };
    await expect(admitFinancialAttachment(financier, command, { db })).rejects.toThrow("financial_attachment_forbidden");
    const admission = await admitFinancialAttachment(owner, command, { db }), file = await uploadFinancialAttachment(owner, { id: admission.id }, bytes, { db, objects: objectStore() });
    expect((await downloadFinancialAttachment(owner, { id: file.id }, { db, objects: objectStore() })).bytes).toEqual(bytes);
    await expect(downloadFinancialAttachment(financier, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    for (const row of (await listAuditHistory(financier, { resourceId: file.id }, { db })).rows) expect(row.after).toBe(maskedValue);
    expect(JSON.stringify(await listAuditHistory(owner, { resourceId: file.id }, { db }))).toContain(hash(bytes));
    const salaryReader = await actor(f, { keys: ["financial_transaction:view", "financial_transaction:export", "financial_attachment:view", "financial_attachment:export", "staff_compensation:view", "employee_payable:view", "expense:view"] });
    expect((await downloadFinancialAttachment(salaryReader, { id: file.id }, { db, objects: objectStore() })).bytes).toEqual(bytes);
    const cost = await withTenant(db, f.org, async tx => {
      await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.company_expenses", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: owner.actorId,
        value: { categories: [{ key: "salary", data_class: "STAFF_COMPENSATION", labels: { en: "Staff compensation", fr: "Rémunération du personnel", ar: "تعويضات الموظفين" } }],
          cost_centers: [{ key: "document_staff", labels: { en: "Staff document evidence", fr: "Justificatifs du personnel", ar: "مستندات الموظفين" } }] }, reason: "Explicit native company salary document classifications" });
      return tx.employeeCompensationCost.findFirstOrThrow({ where: { organizationId: f.org, claimId } });
    });
    const plan = await createCompanyExpensePlan(owner, { category: "salary", costCenter: "document_staff", amount: cost.amount.toString(), currency: cost.currency,
      dueOn: now.toISOString().slice(0,10), purpose: "Actual original company salary document source", idempotencyKey: randomUUID(), reason: "Actual company salary document plan" }, { db }),
      binding = { companyExpenseId: plan.id, employeeCostId: cost.id, expectedPlanVersion: 1, reason: "Retained original company classification for salary documents" };
    await changeCompanyExpenseCompensationSource(owner, { ...binding, operation: "ATTACH", expectedSourceVersion: 0 }, { db });
    await expect(downloadFinancialAttachment(salaryReader, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    await changeCompanyExpenseCompensationSource(owner, { ...binding, operation: "RELEASE", expectedSourceVersion: 1 }, { db });
    await expect(downloadFinancialAttachment(salaryReader, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    expect((await downloadFinancialAttachment(owner, { id: file.id }, { db, objects: objectStore() })).bytes).toEqual(bytes);
  });
  it("refuses metadata completion when current source authority is revoked during object transport", async () => {
    const f = await fixture(), owner = await actor(f), admission = await admitFinancialAttachment(owner, input(f), { db }); let revoked = false;
    const transport: typeof fetch = async (url, init) => { const response = await fetch(url, init); if (!revoked) { revoked = true;
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: owner.assignment.id }, data: { validTo: new Date("2021-01-01") } })); } return response; };
    await expect(uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore(transport) })).rejects.toThrow("financial_attachment_forbidden");
    expect(await withTenant(db, f.org, tx => tx.financialAttachment.count())).toBe(0);
  });
  it("refuses plaintext release when current export authority is revoked after storage has answered", async () => {
    const f = await fixture(), owner = await actor(f), file = await attach(f, owner); let revoked = false;
    const transport: typeof fetch = async (url, init) => { const response = await fetch(url, init); if (!revoked) { revoked = true;
      await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: owner.assignment.id }, data: { validTo: new Date("2021-01-01") } })); } return response; };
    await expect(downloadFinancialAttachment(owner, { id: file.id }, { db, objects: objectStore(transport) })).rejects.toThrow("financial_attachment_forbidden");
    expect(await withTenant(db, f.org, tx => tx.auditLog.count({ where: { resourceId: file.id, action: "finance.financial_attachment.downloaded" } }))).toBe(0);
  });
  it("uploads encrypted originals over HTTP, downloads exact bytes and preserves all financial rows", async () => {
    const f = await fixture(), owner = await actor(f), before = await financialXmins(f), file = await attach(f, owner);
    expect(file).toMatchObject({ version: 1, kind: "RECEIPT", transactionId: f.journal.id, fileSize: content().length });
    const history = await readFinancialAttachments(owner, { transactionId: f.journal.id }, { db }); expect(history.items).toHaveLength(1);
    expect(history.transaction).toMatchObject({ amount: "9007199254740993.07", currency: "MAD" });
    const downloaded = await downloadFinancialAttachment(owner, { id: file.id }, { db, objects: objectStore() }); expect(downloaded.bytes).toEqual(content());
    const encrypted = [...objects.entries()].find(([key]) => key.includes(file.id))![1]; expect(encrypted.includes(content())).toBe(false);
    expect(await financialXmins(f)).toEqual(before);
    const actions = await withTenant(db, f.org, tx => tx.auditLog.findMany({ where: { resourceId: file.id }, select: { action: true } }));
    expect(actions.map(row => row.action)).toEqual(expect.arrayContaining(["finance.financial_attachment.admitted", "finance.financial_attachment.attached", "finance.financial_attachment.downloaded"]));
  });
  it("retains original and corrected versions with exact original bytes and a linear append-only history", async () => {
    const f = await fixture(), owner = await actor(f), original = await attach(f, owner), correctedBytes = content("Corrected invoice evidence");
    const corrected = await attach(f, owner, correctedBytes, { supersedesId: original.id }); expect(corrected).toMatchObject({ rootId: original.id, version: 2, supersedesId: original.id });
    const history = await readFinancialAttachments(owner, { transactionId: f.journal.id }, { db }); expect(history.items).toHaveLength(2);
    expect(history.items.find(row => row.id === original.id)?.supersededById).toBe(corrected.id);
    expect((await downloadFinancialAttachment(owner, { id: original.id }, { db, objects: objectStore() })).bytes).toEqual(content());
    expect((await downloadFinancialAttachment(owner, { id: corrected.id }, { db, objects: objectStore() })).bytes).toEqual(correctedBytes);
    await expect(attach(f, owner, correctedBytes, { supersedesId: original.id })).rejects.toThrow("financial_attachment_conflict");
  });
  it("replays the same durable admission and refuses changed metadata or original bytes", async () => {
    const f = await fixture(), owner = await actor(f), command = input(f), first = await admitFinancialAttachment(owner, command, { db });
    expect(await admitFinancialAttachment(owner, command, { db })).toEqual(first);
    await expect(admitFinancialAttachment(owner, { ...command, reason: "Changed original evidence reason" }, { db })).rejects.toThrow("financial_attachment_conflict");
    await expect(uploadFinancialAttachment(owner, { id: first.id }, content("Altered receipt"), { db, objects: objectStore() })).rejects.toThrow("financial_attachment_invalid_file");
    const saved = await uploadFinancialAttachment(owner, { id: first.id }, content(), { db, objects: objectStore() });
    expect(await uploadFinancialAttachment(owner, { id: first.id }, content(), { db, objects: objectStore() })).toEqual(saved);
    expect(await withTenant(db, f.org, tx => tx.financialAttachment.count())).toBe(1);
  });
  it("keeps admission and its budget after invalid content or transport failure", async () => {
    const f = await fixture(2), owner = await actor(f), invalid = Buffer.from("<script>not a receipt</script>"), admission = await admitFinancialAttachment(owner, input(f, invalid), { db });
    await expect(uploadFinancialAttachment(owner, { id: admission.id }, invalid, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_invalid_file");
    const second = await admitFinancialAttachment(owner, input(f), { db });
    await expect(uploadFinancialAttachment(owner, { id: second.id }, content(), { db, objects: objectStore(() => Promise.reject(Error("local transport unavailable"))) })).rejects.toThrow("financial_attachment_storage_unavailable");
    await expect(admitFinancialAttachment(owner, input(f), { db })).rejects.toThrow("financial_attachment_rate_limited");
    expect(await withTenant(db, f.org, tx => tx.financialAttachmentAdmission.count())).toBe(2); expect(await withTenant(db, f.org, tx => tx.financialAttachment.count())).toBe(0);
    // The existing limiter records every attempt, including the refused third request.
    const buckets = await withTenant(db, f.org, tx => tx.rateLimitBucket.findMany({ where: { keyHash: hashRateLimitKey("finance.financial_attachment:" + owner.actorId) } })); expect(buckets.reduce((sum, row) => sum + row.count, 0)).toBe(3);
  });
  it("recovers a lost storage acknowledgement without replacing original ciphertext", async () => {
    const f = await fixture(), owner = await actor(f), admission = await admitFinancialAttachment(owner, input(f), { db }); let lose = true, requests = 0;
    const transport: typeof fetch = async (url, init) => { requests++; const response = await fetch(url, init); if (lose && init?.method === "PUT") { lose = false; throw Error("local acknowledgement lost"); } return response; };
    await expect(uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore(transport) })).rejects.toThrow("financial_attachment_storage_unavailable");
    expect(requests).toBe(1); const original = Buffer.from([...objects.entries()].find(([key]) => key.includes(admission.id))![1]);
    const recovered = await uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore(transport) }); expect(recovered.id).toBe(admission.id); expect(requests).toBe(3);
    expect([...objects.entries()].find(([key]) => key.includes(admission.id))![1]).toEqual(original);
  });
  it("requires independent document, original financial and current stored permissions at source scope", async () => {
    const f = await fixture(), owner = await actor(f), file = await attach(f, owner), operational = await actor(f, { keys: ["property:view"] }),
      documentOnly = await actor(f, { keys: ["financial_attachment:view", "financial_attachment:export"] }),
      financialOnly = await actor(f, { keys: ["financial_transaction:view", "financial_transaction:export"] }),
      capped = await actor(f, { cap: "9007199254740993.06" }), wrongProperty = await actor(f, { propertyId: randomUUID() });
    for (const reader of [operational, documentOnly, financialOnly, capped, wrongProperty]) await expect(downloadFinancialAttachment(reader, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    const scoped = await actor(f, { propertyId: f.property.id }); expect((await downloadFinancialAttachment(scoped, { id: file.id }, { db, objects: objectStore() })).bytes).toEqual(content());
    const held = { ...owner, authContext: restoreAuthorizationCap(captureAuthorizationCap(owner.authContext)) };
    await withTenant(db, f.org, tx => tx.roleAssignment.update({ where: { id: owner.assignment.id }, data: { validTo: new Date("2021-01-01") } }));
    await expect(downloadFinancialAttachment(held, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
  });
  it("requires source export independently of file viewing and does not sum different currencies under a cap", async () => {
    const f = await fixture(100, true), owner = await actor(f), file = await attach(f, owner), capped = await actor(f, { cap: "9999999999999999.99" }),
      viewer = await actor(f, { keys: ["financial_transaction:view", "financial_attachment:view", "financial_attachment:export"] });
    expect((await readFinancialAttachments(viewer, { transactionId: f.journal.id }, { db })).items).toHaveLength(1);
    for (const reader of [capped, viewer]) await expect(downloadFinancialAttachment(reader, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    expect((await readFinancialAttachments(owner, { transactionId: f.journal.id }, { db })).transaction).toMatchObject({ amount: null, currency: null });
  });
  it("rejects foreign tenants and other actors' upload admissions without revealing existence", async () => {
    const f = await fixture(), owner = await actor(f), admission = await admitFinancialAttachment(owner, input(f), { db }), stranger = await actor(f), foreign = await actor(await fixture());
    for (const reader of [stranger, foreign]) await expect(uploadFinancialAttachment(reader, { id: admission.id }, content(), { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    const file = await uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() });
    await expect(downloadFinancialAttachment(foreign, { id: file.id }, { db, objects: objectStore() })).rejects.toThrow("financial_attachment_forbidden");
    expect(await withTenant(db, foreign.organizationId, tx => tx.financialAttachment.findMany({ where: { id: file.id } }))).toEqual([]);
  });
  it("refuses a source-policy change during storage and retains only the private encrypted orphan", async () => {
    const f = await fixture(), owner = await actor(f), admission = await admitFinancialAttachment(owner, input(f), { db }); let changed = false;
    const transport: typeof fetch = async (url, init) => { const response = await fetch(url, init); if (!changed) { changed = true;
      await withTenant(db, f.org, tx => new ConfigRuleRepository(tx, f.org).createVersion({ key: financialAttachmentPolicyKey, scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: owner.actorId,
        value: { ...policy(), max_bytes: 2048 }, reason: "Explicit native admission policy changed during transport" })); } return response; };
    await expect(uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore(transport) })).rejects.toThrow("financial_attachment_conflict");
    expect(await withTenant(db, f.org, tx => tx.financialAttachment.count())).toBe(0); expect([...objects.keys()].some(key => key.includes(admission.id))).toBe(true);
  });
  it("atomically rolls metadata back if attributed audit cannot be written, then recovers the same admission", async () => {
    const f = await fixture(), owner = await actor(f), admission = await admitFinancialAttachment(owner, input(f), { db }), original = auditWriter.writeAuditEvent;
    const spy = vi.spyOn(auditWriter, "writeAuditEvent").mockImplementation(async (tx, event) => { if (event.action === "finance.financial_attachment.attached") throw Error("dedicated local audit failure"); return original(tx, event); });
    try { await expect(uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() })).rejects.toThrow("dedicated local audit failure"); } finally { spy.mockRestore(); }
    expect(await withTenant(db, f.org, tx => tx.financialAttachment.count())).toBe(0);
    expect((await uploadFinancialAttachment(owner, { id: admission.id }, content(), { db, objects: objectStore() })).id).toBe(admission.id);
  });
  it("protects original attachment audit values and reasons from audit-only readers and unauthorized CSV export", async () => {
    const f = await fixture(), owner = await actor(f), file = await attach(f, owner), auditOnly = await actor(f, { keys: ["audit_log:view", "audit_log:export"] });
    const filters = { resourceId: file.id };
    const hidden = await listAuditHistory(auditOnly, filters, { db }); expect(hidden.rows.length).toBeGreaterThan(0);
    for (const row of hidden.rows) expect(row).toMatchObject({ after: maskedValue, reason: maskedValue });
    expect(await exportAuditHistoryCsv(auditOnly, filters, { db })).not.toContain(hash(content()));
    expect(JSON.stringify(await listAuditHistory(owner, filters, { db }))).toContain(hash(content()));
    expect(await exportAuditHistoryCsv(owner, filters, { db })).toContain(hash(content()));
  });
  it("rejects updates, deletion, unaudited native metadata and history forks at the database boundary", async () => {
    const f = await fixture(), owner = await actor(f), original = await attach(f, owner), first = await admitFinancialAttachment(owner, input(f, content("Correction one"), { supersedesId: original.id }), { db }),
      second = await admitFinancialAttachment(owner, input(f, content("Correction two"), { supersedesId: original.id }), { db });
    const results = await Promise.allSettled([uploadFinancialAttachment(owner, { id: first.id }, content("Correction one"), { db, objects: objectStore() }), uploadFinancialAttachment(owner, { id: second.id }, content("Correction two"), { db, objects: objectStore() })]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1); expect(results.filter(row => row.status === "rejected")).toHaveLength(1);
    await expect(withTenant(db, f.org, tx => tx.financialAttachment.update({ where: { id: original.id }, data: { cipherSha256: "a".repeat(64) } }))).rejects.toThrow("financial_attachment_append_only");
    await expect(withTenant(db, f.org, tx => tx.financialAttachmentAdmission.delete({ where: { id: original.id } }))).rejects.toThrow("financial_attachment_append_only");
    const admission = await admitFinancialAttachment(owner, input(f), { db }), row = await withTenant(db, f.org, tx => tx.financialAttachmentAdmission.findUniqueOrThrow({ where: { id: admission.id } }));
    await expect(withTenant(db, f.org, tx => tx.financialAttachment.create({ data: { id: row.id, organizationId: f.org, transactionId: f.journal.id, rootId: row.id, version: 1,
      storageKey: `organizations/${f.org}/financial-transactions/${f.journal.id}/attachments/${row.id}.encrypted`, cipherSize: row.fileSize + 100, cipherSha256: "a".repeat(64), keyVersion: "native", createdAt: new Date() } }))).rejects.toThrow("financial_attachment_atomic_original_file_audit_required");
  });
  it("offers bounded native transaction choices and refuses a source in another tenant", async () => {
    const f = await fixture(), owner = await actor(f), editor = await readFinancialAttachmentEditor(owner, { query: f.journal.reference }, { db });
    expect(editor.items).toEqual([expect.objectContaining({ id: f.journal.id, amount: "9007199254740993.07" })]);
    expect((await readFinancialAttachmentEditor(owner, { query: "nonexistent-dedicated-source" }, { db })).items).toHaveLength(0);
    await expect(admitFinancialAttachment(await actor(await fixture()), input(f), { db })).rejects.toThrow("financial_attachment_forbidden");
  });
});
