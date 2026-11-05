import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { Document, Page, Text, renderToBuffer } from "@react-pdf/renderer";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { openFieldFixture } from "./support/field-fixture";
import { forwardBrowserPostOnce } from "./support/forward-browser-post";
import { acknowledgementBarrier } from "./support/acknowledgement-barrier";

for (const locale of ["en", "fr", "ar"] as const) test(`Original financial receipts and corrected invoices retain private history in ${locale}`, async ({ page, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Dedicated native PostgreSQL required"); test.setTimeout(240000);
  const f = await openFieldFixture(page, info, locale), headers = { Origin: new URL(page.url()).origin }, pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.name));
  const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: { cookies: [], origins: [] } });
  try {
    const source = await withTenant(f.db, f.organizationId, async tx => {
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }), actorId = task.assignedToUserAccountId!, finance = new FinanceRepository(tx, f.organizationId);
      await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "finance.transaction_attachments", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: actorId,
        value: { source: "ORIGINAL_SEALED_FINANCIAL_TRANSACTION", content_types: ["application/pdf", "image/png"], max_bytes: 1048576, intent_lifetime_seconds: 600, storage_read_ttl_seconds: 30,
          encryption: "APP_MANAGED_AUTHENTICATED_ENCRYPTION", history: "APPEND_ONLY_WITH_RETAINED_SUPERSEDED_FILES", rate_limit: { requests: 1000, window_seconds: 3600 } }, reason: "Explicit original-document browser acceptance policy" });
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase(), bank = await finance.ensureLedgerAccount({ code: "ATTACHMENT_BANK_" + suffix, name: "Actual browser document bank", accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
        claim = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Actual browser document ownership", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" }), amount = Money.of("9007199254740993.07", "MAD"), dimensions = { property_id: task.propertyId };
      const journal = await finance.createFinancialTransaction({ reference: "ORIGINAL-DOCUMENT:" + suffix, description: "Actual original browser receipt source", idempotencyKey: randomUUID(), occurredAt: new Date("2032-05-01T12:00:00Z"), createdBy: actorId,
        postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "OWNER_REVENUE", dimensions }, { ledgerAccountId: claim.id, side: "CREDIT", amount, bucket: "OWNER_REVENUE", dimensions }] });
      return { actorId, journal };
    });
    const xmins = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<{ id: string; xmin: string }[]>`
      SELECT id::text,xmin::text FROM financial_transaction WHERE organization_id=${f.organizationId}::uuid AND id=${source.journal.id}::uuid
      UNION ALL SELECT id::text,xmin::text FROM posting WHERE organization_id=${f.organizationId}::uuid AND transaction_id=${source.journal.id}::uuid ORDER BY id`), before = await xmins();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDQAAAABJRU5ErkJggg==", "base64"),
      pdf = await renderToBuffer(createElement(Document, {}, createElement(Page, { size: "A6" }, createElement(Text, {}, "Actual original financial invoice"))));
    const command = { transactionId: source.journal.id, idempotencyKey: randomUUID(), kind: "RECEIPT", fileName: "إيصال-original.png", contentType: "image/png", fileSize: png.length,
      sha256: createHash("sha256").update(png).digest("hex"), reason: "Actual original browser financial receipt" };
    for (const endpoint of ["editor", "history", "admit", "download", "upload"]) {
      const response = await anonymous.request.post("/api/finance/attachments/" + endpoint, { headers, data: command }); expect(response.status()).toBe(401); expect(response.headers()["cache-control"]).toBe("private, no-store");
    }
    expect((await page.request.post("/api/finance/attachments/admit", { headers: { Origin: "https://foreign.example.test" }, data: command })).status()).toBe(403);
    expect((await page.request.post("/api/finance/attachments/admit", { headers, data: { ...command, organizationId: randomUUID() } })).status()).toBe(400);
    expect((await page.request.post("/api/finance/attachments/admit?forged=1", { headers, data: command })).status()).toBe(400);
    if (info.project.name === "field-mobile") await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/${locale}/app/finance/attachments?transactionId=${source.journal.id}`);
    const form = page.getByTestId("attachment-upload-form"); await expect(form).toBeVisible();
    const native = await page.request.post("/api/finance/attachments/history", { headers, data: { transactionId: source.journal.id } }); expect(native.status()).toBe(200);
    expect((await native.json() as { transaction: { amount: string; currency: string } }).transaction).toMatchObject({ amount: "9007199254740993.07", currency: "MAD" });
    await page.getByTestId("attachment-file").setInputFiles({ name: command.fileName, mimeType: "image/png", buffer: png }); await page.getByTestId("attachment-reason").fill(command.reason);
    let forwardCount = 0;
    const lostAcknowledgement = acknowledgementBarrier();
    await page.route("**/api/finance/attachments/upload?**", async route => {
      if (forwardCount++) { await route.continue(); return; }
      try {
        expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort();
        lostAcknowledgement.resolve();
      } catch (error) { lostAcknowledgement.reject(error); throw error; }
    });
    await page.getByTestId("attachment-submit").click(); await lostAcknowledgement.promise; await expect(page.getByTestId("attachment-result")).toBeVisible(); await expect(page.getByTestId("attachment-submit")).toBeEnabled();
    expect(await withTenant(f.db, f.organizationId, tx => tx.financialAttachment.count({ where: { transactionId: source.journal.id } }))).toBe(1);
    await page.getByTestId("attachment-submit").click(); await expect(page.getByTestId("attachment-history-item")).toHaveCount(1); expect(forwardCount).toBe(2);
    await page.unroute("**/api/finance/attachments/upload?**");
    const originalRow = page.getByTestId("attachment-history-item").filter({ hasText: command.fileName }), originalDownload = page.waitForEvent("download"); await originalRow.getByRole("button").first().click();
    const originalFile = await originalDownload, originalPath = await originalFile.path(); if (!originalPath) throw Error("Original receipt bytes required");
    expect(await readFile(originalPath)).toEqual(png); expect(originalFile.suggestedFilename()).toBe(command.fileName);
    await originalRow.getByRole("button").last().click(); await page.getByTestId("attachment-file").setInputFiles({ name: "corrected-financial-receipt.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByTestId("attachment-reason").fill("Actual corrected financial receipt, retaining the original"); await page.getByTestId("attachment-submit").click();
    await expect(page.getByTestId("attachment-history-item")).toHaveCount(2);
    const correctedRow = page.getByTestId("attachment-history-item").filter({ hasText: "corrected-financial-receipt.pdf" }), correctedDownload = page.waitForEvent("download"); await correctedRow.getByRole("button").first().click();
    const correctedFile = await correctedDownload, correctedPath = await correctedFile.path(); if (!correctedPath) throw Error("Corrected receipt bytes required"); expect(await readFile(correctedPath)).toEqual(pdf);
    await page.getByTestId("attachment-kind").selectOption("INVOICE"); await page.getByTestId("attachment-file").setInputFiles({ name: "original-financial-invoice.pdf", mimeType: "application/pdf", buffer: pdf });
    await page.getByTestId("attachment-reason").fill("Actual original financial invoice, independently attached"); await page.getByTestId("attachment-submit").click(); await expect(page.getByTestId("attachment-history-item")).toHaveCount(3);
    const history = await page.request.post("/api/finance/attachments/history", { headers, data: { transactionId: source.journal.id } });
    const records = await history.json() as { items: { id: string; version: number; supersedesId: string | null; sha256: string }[] };
    expect(records.items.map(row => row.version).sort()).toEqual([1, 1, 2]); expect(records.items.filter(row => row.supersedesId)).toHaveLength(1);
    const download = await page.request.post("/api/finance/attachments/download", { headers, data: { id: records.items[0].id } }); expect(download.status()).toBe(200);
    expect(download.headers()["cache-control"]).toBe("private, no-store"); expect(download.headers()["x-content-type-options"]).toBe("nosniff"); expect(download.headers()["content-security-policy"]).toBe("sandbox");
    expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(pageErrors).toEqual([]); await page.screenshot({ path: info.outputPath("financial-attachments.png"), fullPage: true }); expect(await xmins()).toEqual(before);
    await page.context().setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline"))); await expect(form).toHaveCount(0); await expect(page.getByTestId("attachment-history-item")).toHaveCount(0);
    await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online"))); await page.goto(`/${locale}/app/finance/attachments?transactionId=${source.journal.id}`); await expect(form).toBeVisible();
    await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.updateMany({ where: { userAccountId: source.actorId, archivedAt: null }, data: { archivedAt: new Date() } }));
    const denied = await page.request.post("/api/finance/attachments/download", { headers, data: { id: records.items[0].id } }); expect(denied.status()).toBe(403); expect(denied.headers()["content-disposition"]).toBeUndefined();
    await page.getByTestId("financial-attachments-workspace").getByRole("button").last().click(); await expect(form).toHaveCount(0); await expect(page.getByTestId("attachment-history-item")).toHaveCount(0); expect(await xmins()).toEqual(before);
  } finally { await anonymous.close(); await f.db.$disconnect(); }
});
