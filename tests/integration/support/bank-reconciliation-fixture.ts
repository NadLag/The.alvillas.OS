import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { expect } from "vitest";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { bankStatementPolicySchema } from "@/platform/config/bank-statement-policy";
import { postGuestDepositReceipt, reviewGuestDepositReceipt } from "@/modules/finance/application/guest-deposit-service";
import { importBankStatement, reviewBankStatement } from "@/modules/finance/application/bank-statement-import";
import { actualGuestDepositFixture } from "./guest-deposit-fixture";

export const actualBankReplacementSource = (id: string, originalId: string, amount: string) => `<OFX><BANKMSGSRSV1><STMTTRNRS><STATUS><CODE>0</CODE></STATUS><STMTRS><CURDEF>MAD</CURDEF><BANKACCTFROM><BANKID>actual-bank</BANKID><ACCTID>actual-account-1234</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20261103</DTSTART><DTEND>20261103</DTEND><STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>${amount}</TRNAMT><FITID>${id}</FITID><CORRECTFITID>${originalId}</CORRECTFITID><CORRECTACTION>REPLACE</CORRECTACTION></STMTTRN></BANKTRANLIST><LEDGERBAL><BALAMT>0.07</BALAMT><DTASOF>20261103</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

export async function actualBankReconciliationFixture(db: PrismaClient, admin: PrismaClient, amounts = ["0.07"]) {
  const f = await actualGuestDepositFixture(db, admin);
  const policy = bankStatementPolicySchema.parse({ source: "ORIGINAL_BANK_STATEMENT", accounts: [{ account_code: f.banks.receipt.code,
    bank_id: "actual-bank", branch_id: null, account_id: "actual-account-1234", account_type: "CHECKING", currency: "MAD", ofx: true,
    csv: { delimiter: ";", dateFormat: "YYYY-MM-DD", decimalSeparator: ".", groupingSeparator: "", columns: { postedDate: "date", transactionId: "id", reference: "reference", description: "description", currency: "currency", amount: "amount" } } }],
    encoding: "UTF-8", max_bytes: 1000000, max_rows: 5000, matching: { date_window_days: 0, amount_tolerance: "0.00", reference: "NONE", admission: "EXPLICIT_REVIEW", ledger_effect: "NONE" },
    source_corrections: "APPEND_AND_REOPEN_REVIEW", duplicate_csv_without_id: "RETAIN_EVERY_ROW" });
  const matcher = await withTenant(db, f.org, async tx => {
    const keys = ["bank_statement:view", "bank_statement:create", "bank_statement:reconcile", "financial_transaction:reconcile"];
    const permissions = await tx.permission.findMany({ where: { organizationId: f.org, key: { in: keys } } }); expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({ data: permissions.filter(row => !row.key.endsWith(":reconcile")).map(row => ({ organizationId: f.org, roleId: f.role.id, permissionId: row.id })) });
    const role = await tx.role.create({ data: { organizationId: f.org, key: "actual_bank_matcher", name: "Independent actual bank matching authority" } });
    await tx.rolePermission.createMany({ data: permissions.filter(row => row.key.endsWith(":reconcile")).map(row => ({ organizationId: f.org, roleId: role.id, permissionId: row.id })) });
    const grant = await tx.roleAssignment.create({ data: { organizationId: f.org, roleId: role.id, userAccountId: f.account.id, personId: f.person.id, scopeType: "organization", validFrom: new Date("2020-01-01") } });
    await new ConfigRuleRepository(tx, f.org).createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: f.account.id, value: policy, reason: "Explicit actual bank matching without creating financial movements" });
    return { role, grant };
  });
  const ctx = { ...f.ctx, authContext: { ...await authContextForAccount(f.org, f.account.id, { db }), personId: f.person.id } };
  const receiptReview = await reviewGuestDepositReceipt(ctx, f.receiptInput, { db });
  const receipt = await postGuestDepositReceipt(ctx, { ...f.receiptInput, reviewFingerprint: receiptReview.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Original actual guest bank receipt before bank matching" }, { db });
  const objects = new Map<string, Uint8Array>();
  const storage = {
    createSignedUploadUrl: ({ key }: { key: string; contentType: string }) => Promise.resolve({ url: "https://matching-storage.example.test/" + encodeURIComponent(key) }),
    createSignedDownloadUrl: ({ key }: { key: string; expiresInSeconds: number }) => Promise.resolve({ url: "https://matching-storage.example.test/" + encodeURIComponent(key) })
  };
  const transport: typeof fetch = async (input, init) => {
    const target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (target.origin !== "https://matching-storage.example.test") throw Error("Owned test storage required");
    const key = decodeURIComponent(target.pathname.slice(1));
    if (init?.method === "PUT") {
      expect(new Headers(init.headers).get("If-None-Match")).toBe("*");
      if (objects.has(key)) return new Response(null, { status: 412 });
      objects.set(key, new Uint8Array(await new Response(init.body).arrayBuffer())); return new Response(null, { status: 200 });
    }
    const bytes = objects.get(key);
    return bytes ? new Response(new Uint8Array(bytes), { status: 200 }) : new Response(null, { status: 404 });
  };
  const deps = { db, storage, transport };
  const admit = async (source: string, format: "CSV" | "OFX" = "CSV") => {
    const bytes = new TextEncoder().encode(source), input = { accountId: f.banks.receipt.id, format, fileSha256: createHash("sha256").update(bytes).digest("hex"), fileSize: bytes.byteLength };
    const review = await reviewBankStatement(ctx, input, bytes, deps);
    return importBankStatement(ctx, { ...input, reviewFingerprint: review.reviewFingerprint, idempotencyKey: randomUUID(), reason: "Retain actual original bank facts for explicit matching" }, bytes, deps);
  };
  await admit("Date;ID;Reference;Description;Amount;Currency\n" + amounts.map((amount, i) => `2026-11-03;bank-${i + 1};actual-reference;Original actual bank movement;${amount};MAD`).join("\n"));
  const sources = await withTenant(db, f.org, async tx => ({ posting: await tx.posting.findFirstOrThrow({ where: { transactionId: receipt.id, ledgerAccountId: f.banks.receipt.id } }),
    lines: await tx.bankStatementLine.findMany({ orderBy: { externalId: "asc" } }) }));
  return { ...f, ctx, matcher, policy, receipt, ...sources, admit, deps: { db } };
}
