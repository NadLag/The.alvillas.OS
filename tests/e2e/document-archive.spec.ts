import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { Document, Page as PdfPage, Text, renderToBuffer } from "@react-pdf/renderer";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { openFieldFixture } from "./support/field-fixture";
import { forwardBrowserPostOnce } from "./support/forward-browser-post";
import { acknowledgementBarrier } from "./support/acknowledgement-barrier";
import { authContextForAccount } from "@/platform/authz/account-context";
import { createSupplier } from "@/modules/finance/application/supplier-service";
import { documentCategories } from "@/modules/documents/domain/document-policy";
import en from "../../messages/en.json" with { type: "json" };
import fr from "../../messages/fr.json" with { type: "json" };
import ar from "../../messages/ar.json" with { type: "json" };
import { Temporal } from "temporal-polyfill";
import { calendarDateAt } from "@/i18n/format";
import { scheduleDocumentExpiryReminders } from "@/modules/documents/application/document-expiry-reminders";

type Fixture = Awaited<ReturnType<typeof openFieldFixture>>;
async function archiveFixture(f: Fixture) {
  return withTenant(f.db, f.organizationId, async tx => {
    const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }), actorId = task.assignedToUserAccountId!;
    const property = await tx.property.findUniqueOrThrow({ where: { id: task.propertyId } });
    await new ConfigRuleRepository(tx, f.organizationId).createVersion({ key: "documents.archive", scopeType: "property", scopeId: property.id,
      effectiveFrom: new Date("2020-01-01"), createdBy: actorId, reason: "Explicit private archive browser acceptance policy",
      value: { source: "NATIVE_DOCUMENT_ARCHIVE", encryption: "APP_MANAGED_AEAD", history: "APPEND_ONLY", downloads: "AUTHORIZED_SERVER_PROXY", storage_url_seconds: 1,
        upload_admission: { window_seconds: 3600, max_requests: 100 }, upload_transport: { window_seconds: 3600, max_requests: 200 },
        types: [{ key: "agreement", labels: { en: "Agreement", fr: "Contrat", ar: "اتفاقية" }, sources: ["PROPERTY"], privacy: ["operational"], content_types: ["application/pdf", "text/plain"], max_bytes: 6 * 1024 * 1024 },
          { key: "ledger_evidence", labels: { en: "Ledger evidence", fr: "Justificatif comptable", ar: "إثبات محاسبي" }, sources: ["FINANCIAL_TRANSACTION"], privacy: ["financial"], content_types: ["application/pdf", "text/plain"], max_bytes: 6 * 1024 * 1024 }] } });
    return { actorId, property };
  });
}
async function chooseSource(page: Page, kind: string, label: string) {
  await page.getByTestId("document-source-kind").selectOption(kind);
  await page.getByTestId("document-source-query").fill(label);
  const source = page.getByTestId("document-source").filter({ hasText: label });
  await expect(source).toHaveCount(1); await source.click();
  await expect(page.getByTestId("document-file-editor")).toBeVisible();
}
async function fillFile(page: Page, file: { name: string; mimeType: string; buffer: Buffer }, title: string, reason: string) {
  await page.getByTestId("document-title-input").fill(title);
  await page.getByTestId("document-file").setInputFiles(file);
  await page.getByTestId("document-reason").fill(reason);
}
async function downloadFile(page: Page, name: string, bytes: Buffer) {
  const version = page.getByTestId("document-version").filter({ hasText: name }), button = version.getByTestId("document-download");
  await expect(version).toHaveCount(1); await expect(button).toBeEnabled(); await button.scrollIntoViewIfNeeded();
  await expect.poll(() => button.evaluate(element => {
    const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2;
    return box.width >= 48 && box.height >= 48 && x >= 0 && x < window.innerWidth && y >= 0 && y < window.innerHeight && element.contains(document.elementFromPoint(x, y));
  })).toBe(true);
  const geometry = await button.evaluate(element => {
    const box = (item: Element) => { const rect = item.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }; };
    return {
    innerWidth: window.innerWidth, innerHeight: window.innerHeight, screenWidth: screen.width, scrollWidth: document.documentElement.scrollWidth,
    viewport: window.visualViewport ? { width: visualViewport!.width, height: visualViewport!.height, scale: visualViewport!.scale } : null,
    button: box(element),
    overflow: [...document.querySelectorAll("body *")].filter(item => item.getBoundingClientRect().right > document.documentElement.clientWidth + 1).map(item => ({ tag: item.tagName, className: item.className, testId: item.getAttribute("data-testid"), box: box(item) })).slice(0, 30)
  }; });
  await test.info().attach("document-download-geometry", { body: JSON.stringify(geometry), contentType: "application/json" });
  const viewport = page.viewportSize(); if (viewport) expect(geometry.scrollWidth).toBeLessThanOrEqual(viewport.width);
  const pending = page.waitForEvent("download"); await button.click();
  const file = await pending, path = test.info().outputPath("download-" + randomUUID()); await file.saveAs(path);
  expect(file.suggestedFilename()).toBe(name); expect(await readFile(path)).toEqual(bytes);
  await expect(page.getByTestId("document-download").first()).toBeEnabled();
}
async function privatePresentation(page: Page, errors: string[]) {
  expect((await new AxeBuilder({ page }).include("main").analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}
const originalPdf = () => renderToBuffer(createElement(Document, {}, createElement(PdfPage, { size: "A6" }, createElement(Text, {}, "Retained original private document"))));

for (const locale of ["en", "fr", "ar"] as const) {
  test(`Private financial archive recovers lost admissions and uploads, retains amendments and revokes access in ${locale}`, async ({ page, browser }, info) => {
    test.skip(!process.env.DATABASE_URL, "Dedicated native PostgreSQL required"); test.setTimeout(240000);
    const f = await openFieldFixture(page, info, locale), headers = { Origin: new URL(page.url()).origin }, pageErrors: string[] = []; let exposedStorageLinks = 0;
    page.on("request", request => { const url = new URL(request.url()); if (url.hostname.endsWith(".r2.cloudflarestorage.com") || url.searchParams.has("X-Amz-Signature")) exposedStorageLinks++; });
    page.on("pageerror", error => pageErrors.push(error.name));
    const anonymous = await browser.newContext({ baseURL: new URL(page.url()).origin, storageState: { cookies: [], origins: [] } });
    try {
      const fixture = await archiveFixture(f), source = await withTenant(f.db, f.organizationId, async tx => {
        const finance = new FinanceRepository(tx, f.organizationId), suffix = randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase();
        const bank = await finance.ensureLedgerAccount({ code: "DOCUMENT_BANK_" + suffix, name: "Document source custody", accountType: "ASSET_LOCATION", normalSide: "DEBIT" });
        const claim = await finance.ensureLedgerAccount({ code: "OWNER_PAYABLE", name: "Document source ownership", accountType: "CLAIM_OWNERSHIP", normalSide: "CREDIT" });
        const amount = Money.of("9007199254740993.07", "MAD"), dimensions = { property_id: fixture.property.id };
        return finance.createFinancialTransaction({ reference: "DOCUMENT-ARCHIVE:" + suffix, description: "Actual immutable archive financial source", idempotencyKey: randomUUID(), occurredAt: new Date("2032-05-01T12:00:00Z"), createdBy: fixture.actorId,
          postings: [{ ledgerAccountId: bank.id, side: "DEBIT", amount, bucket: "OWNER_REVENUE", dimensions }, { ledgerAccountId: claim.id, side: "CREDIT", amount, bucket: "OWNER_REVENUE", dimensions }] });
      });
      const moneyRows = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<{ id: string; xmin: string; body: string }[]>`
        SELECT t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t WHERE t.organization_id=${f.organizationId}::uuid AND t.id=${source.id}::uuid
        UNION ALL SELECT p.id::text,p.xmin::text,md5(to_jsonb(p)::text) FROM posting p WHERE p.organization_id=${f.organizationId}::uuid AND p.transaction_id=${source.id}::uuid ORDER BY id`), before = await moneyRows();
      for (const endpoint of ["review", "admit", "recover", "history", "upload", "download", "sources", "read", "part", "complete"]) {
        const denied = await anonymous.request.post("/api/documents/" + endpoint, { headers, data: {} });
        expect(denied.status()).toBe(401); expect(denied.headers()["cache-control"]).toBe("private, no-store");
      }
      expect((await page.request.post("/api/documents/sources", { headers: { Origin: "https://foreign.example.test" }, data: { kind: "PROPERTY" } })).status()).toBe(403);
      expect((await page.request.post("/api/documents/sources?forged=1", { headers, data: { kind: "PROPERTY" } })).status()).toBe(400);
      expect((await page.request.post("/api/documents/sources", { headers: { ...headers, "x-alvillas-document-scope": f.organizationId + "." + randomUUID() }, data: { kind: "PROPERTY" } })).status()).toBe(403);
      await page.goto(`/${locale}/app/documents`); await chooseSource(page, "FINANCIAL_TRANSACTION", source.reference);
      const pdf = await originalPdf(), file = { name: "إثبات-original.pdf", mimeType: "application/pdf", buffer: pdf }, reason = "Original private ledger source evidence", title = "Private immutable financial original";
      await fillFile(page, file, title, reason);
      await page.getByTestId("document-effective-from").fill("2020-01-01T09:30");
      let admissionPosts = 0, uploadPosts = 0;
      const admitted = acknowledgementBarrier();
      await page.route("**/api/documents/admit", async route => {
        admissionPosts++;
        try { expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); admitted.resolve(); }
        catch (error) { admitted.reject(error); throw error; }
      });
      await page.getByTestId("document-save").click(); await admitted.promise;
      await expect(page.getByTestId("document-recover")).toBeEnabled();
      const originalAdmission = await withTenant(f.db, f.organizationId, tx => tx.documentAdmission.findFirstOrThrow({ where: { createdBy: fixture.actorId } }));
      expect(originalAdmission.input).toMatchObject({effectiveFrom:"2020-01-01T09:30:00.000Z"});
      expect(await withTenant(f.db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: originalAdmission.documentId } }))).toBe(0);
      const storageKey = "alvillas:document-upload:" + f.organizationId + "." + fixture.actorId;
      const storage = await page.evaluate(() => ({ session: { ...sessionStorage }, local: { ...localStorage } }));
      expect(storage.session[storageKey]).toBe(originalAdmission.commandKey);
      const serialized = JSON.stringify(storage); for (const value of [file.name, title, reason, "9007199254740993.07"]) expect(serialized).not.toContain(value);
      expect(Object.keys(storage.session).filter(key => key.startsWith("alvillas:document-upload:"))).toEqual([storageKey]);
      expect(admissionPosts).toBe(1); await page.unroute("**/api/documents/admit");
      await page.reload(); await expect(page.getByTestId("document-resume-file")).toBeVisible(); await expect(page.getByTestId("document-source-kind")).toHaveValue("FINANCIAL_TRANSACTION");
      const uploaded = acknowledgementBarrier();
      await page.route("**/api/documents/upload?**", async route => {
        uploadPosts++;
        try { expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); uploaded.resolve(); }
        catch (error) { uploaded.reject(error); throw error; }
      });
      await page.getByTestId("document-resume-file").setInputFiles(file); await page.getByTestId("document-resume").click(); await uploaded.promise;
      await expect(page.getByTestId("document-recover")).toBeEnabled();
      expect(await withTenant(f.db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: originalAdmission.documentId } }))).toBe(1); expect(uploadPosts).toBe(1);
      await page.getByTestId("document-recover").click(); await expect(page.getByTestId("document-version")).toHaveCount(1);
      await expect(page.getByTestId("document-recover")).toHaveCount(0); expect(uploadPosts).toBe(1);
      expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull(); await page.unroute("**/api/documents/upload?**");
      const originalRows = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<{ id: string; xmin: string; body: string }[]>`
        SELECT v.id::text,v.xmin::text,md5(to_jsonb(v)::text) AS body FROM document_version v WHERE v.organization_id=${f.organizationId}::uuid AND v.document_id=${originalAdmission.documentId}::uuid AND v.number=1`), originalBefore = await originalRows();
      await downloadFile(page, file.name, pdf);
      await page.getByTestId("document-amend").click();
      const correction = { name: "retained-amendment.pdf", mimeType: "application/pdf", buffer: await originalPdf() };
      await fillFile(page, correction, "Private financial amendment", "Document amendment retains the original source evidence");
      const scheduledField=new Date(Date.now()+86400000).toISOString().slice(0,16),scheduledIso=scheduledField+":00.000Z";await page.getByTestId("document-effective-from").fill(scheduledField);
      await page.getByTestId("document-save").click(); await expect(page.getByTestId("document-version")).toHaveCount(2);
      await expect(page.getByTestId("document-history").locator('[data-effective-state="effective"]')).toHaveCount(1);await expect(page.getByTestId("document-history").locator('[data-effective-state="scheduled"]')).toHaveCount(1);
      expect((await withTenant(f.db,f.organizationId,tx=>tx.documentVersion.findFirstOrThrow({where:{documentId:originalAdmission.documentId,number:2}}))).effectiveFrom?.toISOString()).toBe(scheduledIso);
      await downloadFile(page, correction.name, correction.buffer); await downloadFile(page, file.name, pdf);
      expect(await originalRows()).toEqual(originalBefore); expect(await moneyRows()).toEqual(before);
      const history = await page.request.post("/api/documents/history", { headers, data: { documentId: originalAdmission.documentId } }); expect(history.status()).toBe(200);
      const records = await history.json() as { versions: { id: string; number: number; supersedesId: string | null; supersededById: string | null }[] };
      expect(records.versions.map(row => row.number)).toEqual([2, 1]); expect(records.versions[0].supersedesId).toBe(records.versions[1].id); expect(records.versions[1].supersededById).toBe(records.versions[0].id);
      const download = await page.request.post("/api/documents/download", { headers, data: { versionId: records.versions[1].id } }); expect(download.status()).toBe(200); expect(await download.body()).toEqual(pdf);
      expect(download.headers()["cache-control"]).toBe("private, no-store"); expect(download.headers()["content-security-policy"]).toBe("sandbox"); expect(download.headers()["x-content-type-options"]).toBe("nosniff");
      expect(exposedStorageLinks).toBe(0); await privatePresentation(page, pageErrors); await page.screenshot({ path: info.outputPath("document-financial-archive.png"), fullPage: true });
      await page.context().setOffline(true); await page.evaluate(() => window.dispatchEvent(new Event("offline")));
      await expect(page.getByTestId("document-private-unavailable")).toBeVisible(); await expect(page.getByTestId("document-file-editor")).toHaveCount(0); await expect(page.getByTestId("document-version")).toHaveCount(0);
      expect(await page.evaluate(() => document.body.textContent)).not.toContain(file.name);
      await page.context().setOffline(false); await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page.goto(`/${locale}/app/documents`); await chooseSource(page, "FINANCIAL_TRANSACTION", source.reference);
      await page.getByTestId("document-item").click(); await expect(page.getByTestId("document-version")).toHaveCount(2);
      await withTenant(f.db, f.organizationId, tx => tx.roleAssignment.updateMany({ where: { userAccountId: fixture.actorId, archivedAt: null }, data: { archivedAt: new Date() } }));
      const denied = await page.request.post("/api/documents/download", { headers, data: { versionId: records.versions[1].id } }); expect(denied.status()).toBe(403); expect(denied.headers()["content-disposition"]).toBeUndefined();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expect(page.getByTestId("document-private-unavailable")).toBeVisible(); await expect(page.getByTestId("document-version")).toHaveCount(0); await expect(page.getByTestId("document-file-editor")).toHaveCount(0);
      expect(await moneyRows()).toEqual(before); expect(await originalRows()).toEqual(originalBefore);
    } finally { await anonymous.close(); await f.db.$disconnect(); }
  });

  test(`Private template history resumes bounded multipart transfer and streams retained files in ${locale}`, async ({ page }, info) => {
    test.skip(!process.env.DATABASE_URL, "Dedicated native PostgreSQL required"); test.setTimeout(240000);
    const f = await openFieldFixture(page, info, locale), pageErrors: string[] = []; page.on("pageerror", error => pageErrors.push(error.name));
    try {
      const fixture = await archiveFixture(f), pdf = await originalPdf(), key = "owner_agreement_" + randomUUID().replaceAll("-", "").slice(0, 12);
      await page.goto(`/${locale}/app/documents`); await chooseSource(page, "PROPERTY", fixture.property.name);
      await page.getByTestId("document-kind").selectOption("TEMPLATE"); await page.getByTestId("document-template-code").fill(key);
      const original = { name: "modèle-original.pdf", mimeType: "application/pdf", buffer: pdf };
      const originalTitle = "Retained original agreement template " + key;
      await fillFile(page, original, originalTitle, "Original versioned template archive acceptance");
      await page.getByTestId("document-save").click(); await expect(page.getByTestId("document-version")).toHaveCount(1);
      await expect(page.getByTestId("document-item")).toContainText(originalTitle);
      const viewport = page.viewportSize(); if (viewport) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      const originalVersion = await withTenant(f.db, f.organizationId, tx => tx.documentVersion.findFirstOrThrow({ where: { createdBy: fixture.actorId } }));
      const originalRows = () => withTenant(f.db, f.organizationId, tx => tx.$queryRaw<{ id: string; xmin: string; body: string }[]>`
        SELECT v.id::text,v.xmin::text,md5(to_jsonb(v)::text) AS body FROM document_version v WHERE v.organization_id=${f.organizationId}::uuid AND v.id=${originalVersion.id}::uuid`), before = await originalRows();
      await page.getByTestId("document-amend").click(); await expect(page.getByTestId("document-template-code")).toBeDisabled(); await expect(page.getByTestId("document-template-code")).toHaveValue(key);
      await expect(page.getByTestId("document-locale")).toBeDisabled(); await expect(page.getByTestId("document-locale")).toHaveValue(locale);
      const bytes = Buffer.alloc(5 * 1024 * 1024 + 73, "a"), large = { name: "نسخة-amended-template.txt", mimeType: "text/plain", buffer: bytes };
      await fillFile(page, large, "Versioned agreement text above five MiB", "Retain original template while replacing it with admitted large text");
      const lostPart = acknowledgementBarrier(), partSizes: number[] = []; let firstParts = 0, completions = 0;
      page.on("request", request => { if (new URL(request.url()).pathname === "/api/documents/complete") completions++; });
      await page.route("**/api/documents/part?**", async route => {
        const request = route.request(); partSizes.push(request.postDataBuffer()?.length ?? 0);
        if (new URL(request.url()).searchParams.get("index") !== "0" || firstParts++) { await route.continue(); return; }
        try { expect(await forwardBrowserPostOnce(request)).toBe(200); await route.abort(); lostPart.resolve(); }
        catch (error) { lostPart.reject(error); throw error; }
      });
      await page.getByTestId("document-save").click(); await lostPart.promise; await expect(page.getByTestId("document-recover")).toBeEnabled();
      expect(partSizes).toEqual([262144]); expect(completions).toBe(0);
      expect(await withTenant(f.db, f.organizationId, tx => tx.documentVersion.count({ where: { documentId: originalVersion.documentId } }))).toBe(1);
      await page.reload(); await expect(page.getByTestId("document-resume-file")).toBeVisible();
      const completion = page.waitForResponse(response => new URL(response.url()).pathname === "/api/documents/complete" && response.request().method() === "POST");
      await page.getByTestId("document-resume-file").setInputFiles(large); await page.getByTestId("document-resume").click();
      const completed = await completion; expect(completed.status()).toBe(200);
      expect(await completed.json()).toMatchObject({ recorded: true, state: "COMPLETE", complete: true, documentId: originalVersion.documentId,
        expected: { fileSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } });
      await expect(page.getByTestId("document-version")).toHaveCount(2); await expect(page.getByTestId("document-recover")).toHaveCount(0);
      expect(firstParts).toBe(2); expect(partSizes).toHaveLength(Math.ceil(bytes.length / 262144) + 1); expect(partSizes.every(size => size > 0 && size <= 262144)).toBe(true); expect(completions).toBe(1);
      await page.unroute("**/api/documents/part?**"); await downloadFile(page, large.name, bytes); await downloadFile(page, original.name, pdf);
      const retained = await withTenant(f.db, f.organizationId, async tx => ({ template: await tx.documentTemplate.findFirstOrThrow({ where: { documentId: originalVersion.documentId } }),
        versions: await tx.documentVersion.findMany({ where: { documentId: originalVersion.documentId }, include: { admission: true }, orderBy: { number: "asc" } }),
        instances: await tx.documentInstance.count({ where: { createdBy: fixture.actorId } }), signatures: await tx.signature.count({ where: { requestedBy: fixture.actorId } }) }));
      expect(retained.template.key).toBe(key); expect(retained.template.locale).toBe(locale); expect(retained.versions.map(version => version.number)).toEqual([1, 2]);
      expect(retained.versions[1].supersedesId).toBe(originalVersion.id); expect(retained.versions[1].admission.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
      expect(retained.instances).toBe(0); expect(retained.signatures).toBe(0); expect(await originalRows()).toEqual(before);
      await privatePresentation(page, pageErrors); await page.screenshot({ path: info.outputPath("document-template-multipart.png"), fullPage: true });
    } finally { await f.db.$disconnect(); }
  });

  test(`Version-bound expiry changes recover once, retain exact finances and open private reminder destinations in ${locale}`,async({page,context},info)=>{
    test.skip(!process.env.DATABASE_URL,"Dedicated native PostgreSQL required");test.setTimeout(240000);
    const f=await openFieldFixture(page,info,locale),pageErrors:string[]=[],messages={en,fr,ar}[locale];page.on("pageerror",error=>pageErrors.push(error.name));
    try{
      const native=await withTenant(f.db,f.organizationId,async tx=>{
        const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),actorId=task.assignedToUserAccountId!,account=await tx.userAccount.findUniqueOrThrow({where:{id:actorId}}),property=await tx.property.findUniqueOrThrow({where:{id:task.propertyId}}),profile=await tx.organizationProfile.upsert({where:{organizationId:f.organizationId},create:{organizationId:f.organizationId,brandName:"Actual document expiry browser calendar",timezone:"Africa/Casablanca"},update:{}}),now=(await tx.$queryRaw<Array<{now:Date}>>`SELECT clock_timestamp() AS now`)[0].now;
        const role=await tx.role.create({data:{organizationId:f.organizationId,key:"expiry_acceptance_"+randomUUID(),name:"Explicit independent document expiry acceptance"}}),keys=["document:view","document:create","document:export","document:edit","property:view","property:export","financial_transaction:view","financial_transaction:export","property_finance:view","property_finance:export","config_rule:view","config_rule:configure"],permissions=await tx.permission.findMany({where:{organizationId:f.organizationId,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);
        await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}))});await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:actorId,personId:account.personId,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
        const typeKey="expiry_"+randomUUID().replaceAll("-",""),rules=new ConfigRuleRepository(tx,f.organizationId);
        await rules.createVersion({key:"documents.archive",scopeType:"property",scopeId:property.id,effectiveFrom:new Date("2020-01-01"),createdBy:actorId,reason:"Actual private expiry document source acceptance",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:1,upload_admission:{window_seconds:3600,max_requests:100},types:[{key:typeKey,category:"INVOICE",labels:{en:"Retained expiry evidence",fr:"Justificatif d’échéance conservé",ar:"إثبات تاريخ الانتهاء المحفوظ"},sources:["FINANCIAL_TRANSACTION"],privacy:["financial"],content_types:["application/pdf"],max_bytes:1048576}]}});
        await rules.createVersion({key:"documents.expiry_reminders",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:actorId,reason:"Explicit actual browser document expiry policy",value:{source:"NATIVE_DOCUMENT_VERSIONS",calendar:"ORGANIZATION_PROFILE",principal:"CURRENT_CONFIGURATION_AUTHOR",version_selection:"CURRENT_EFFECTIVE_VERSION",type_keys:[typeKey],change_admission:{window_seconds:3600,max_requests:100},send_at:"00:00",stages:[{key:"due",offset_days:0,repeat_every_days:3,labels:{en:"Document expiry",fr:"Échéance du document",ar:"انتهاء صلاحية الوثيقة"}}]}});
        await rules.createVersion({key:"notification.routing.document_expiring",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:actorId,reason:"Explicit private browser document reminder audience",value:{roles:[],people:[account.personId],assigned:false,channels:["in_app"]}});
        return{actorId,property,typeKey,on:calendarDateAt(now,profile.timezone)};
      }),journal=await withTenant(f.db,f.organizationId,async tx=>{
        const finance=new FinanceRepository(tx,f.organizationId),bank=await finance.ensureLedgerAccount({code:"EXPIRY_BROWSER_"+randomUUID().replaceAll("-","").slice(0,12).toUpperCase(),name:"Actual expiry custody",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Actual immutable owner claim",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),amount=Money.of("9007199254740993.07","MAD"),dimensions={property_id:native.property.id};
        return finance.createFinancialTransaction({reference:"EXPIRY-BROWSER:"+randomUUID(),description:"Exact retained document expiry financial source",idempotencyKey:randomUUID(),createdBy:native.actorId,occurredAt:await finance.clock(),postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"OWNER_REVENUE",dimensions},{ledgerAccountId:claim.id,side:"CREDIT",amount,bucket:"OWNER_REVENUE",dimensions}]});
      });
      await page.goto(`/${locale}/app/documents`);await chooseSource(page,"FINANCIAL_TRANSACTION",journal.reference);const pdf=await originalPdf(),title="Actual private expiry original "+randomUUID(),file={name:"retained-expiry-original.pdf",mimeType:"application/pdf",buffer:pdf};await fillFile(page,file,title,"Retain the original immutable financial expiry document");await page.getByTestId("document-save").click();await expect(page.getByTestId("document-history").getByRole("heading",{name:title,exact:true})).toBeVisible();
      const original=await withTenant(f.db,f.organizationId,tx=>tx.document.findFirstOrThrow({where:{createdBy:native.actorId,typeKey:native.typeKey},include:{versions:{orderBy:{number:"desc"}}}})),version=original.versions[0],snapshot=()=>withTenant(f.db,f.organizationId,tx=>tx.$queryRaw`SELECT 'document' AS kind,t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM document t WHERE organization_id=${f.organizationId}::uuid AND id=${original.id}::uuid UNION ALL SELECT 'version',t.id::text,t.xmin::text,md5(to_jsonb(t)::text) FROM document_version t WHERE organization_id=${f.organizationId}::uuid AND document_id=${original.id}::uuid UNION ALL SELECT 'journal',t.id::text,t.xmin::text,md5(to_jsonb(t)::text) FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid AND id=${journal.id}::uuid UNION ALL SELECT 'posting',t.id::text,t.xmin::text,md5(to_jsonb(t)::text) FROM posting t WHERE organization_id=${f.organizationId}::uuid AND transaction_id=${journal.id}::uuid ORDER BY kind,id`),before=await snapshot(),link=`/${locale}/app/documents?document=${original.id}&version=1`;
      await page.getByTestId("document-open-expiry").click();await expect(page.getByTestId("document-expiry").getByRole("heading",{name:messages.DocumentExpiry.title,exact:true})).toBeVisible();await page.getByTestId("document-expiry-load").click();await expect(page.getByTestId("document-expiry-current")).toHaveText(messages.DocumentExpiry.none);
      const privateReason="Private explicit document expiry reason "+randomUUID();await page.getByTestId("document-expiry-date").fill(native.on);await page.getByTestId("document-expiry-reason").fill(privateReason);await page.getByTestId("document-expiry-review").click();await expect(page.getByTestId("document-expiry-reviewed")).toBeVisible();
      let admissionPosts=0;const admitted=acknowledgementBarrier();await page.route("**/api/documents/expiry/admit",async route=>{admissionPosts++;try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();admitted.resolve();}catch(error){admitted.reject(error);throw error;}});await page.getByTestId("document-expiry-admit").click();await admitted.promise;await expect(page.getByTestId("document-expiry-recover")).toBeEnabled();
      const saved=await withTenant(f.db,f.organizationId,tx=>tx.documentExpiryRevision.findFirstOrThrow({where:{versionId:version.id}})),nonceKey="alvillas:document-expiry:"+f.organizationId+"."+native.actorId+":"+version.id,storage=await page.evaluate(()=>({session:{...sessionStorage},local:{...localStorage}}));expect(storage.session[nonceKey]).toBe(saved.commandKey);for(const value of[privateReason,title,"9007199254740993.07"])expect(JSON.stringify(storage)).not.toContain(value);expect(admissionPosts).toBe(1);await page.unroute("**/api/documents/expiry/admit");
      await page.goto(link);await expect(page.getByTestId("document-expiry-recover")).toBeEnabled();await page.getByTestId("document-expiry-recover").click();await expect(page.getByTestId("document-expiry-saved")).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),nonceKey)).toBeNull();expect(await withTenant(f.db,f.organizationId,tx=>tx.documentExpiryRevision.count({where:{versionId:version.id}}))).toBe(1);
      const change=async(on:string,number:number)=>{await page.getByTestId("document-expiry-load").click();await expect(page.getByTestId("document-expiry-date")).toBeEnabled();await page.getByTestId("document-expiry-date").fill(on);await page.getByTestId("document-expiry-reason").fill("Retain explicit immutable expiry change "+number);await page.getByTestId("document-expiry-review").click();await expect(page.getByTestId("document-expiry-reviewed")).toBeVisible();await page.getByTestId("document-expiry-admit").click();await expect(page.getByTestId("document-expiry-saved")).toHaveText(messages.DocumentExpiry.saved.replace("{number}",new Intl.NumberFormat(locale).format(number)));};
      await change(Temporal.PlainDate.from(native.on).add({days:1}).toString(),2);expect((await scheduleDocumentExpiryReminders(f.organizationId,{db:f.db})).occurrences).toBe(0);await change(native.on,3);expect(await scheduleDocumentExpiryReminders(f.organizationId,{db:f.db})).toMatchObject({occurrences:1,notificationsRequested:1});expect((await scheduleDocumentExpiryReminders(f.organizationId,{db:f.db})).occurrences).toBe(0);
      const notice=await withTenant(f.db,f.organizationId,tx=>tx.notification.findFirstOrThrow({where:{recipientId:native.actorId,kind:"document_expiring"},orderBy:{createdAt:"desc"}}));await page.goto(`/${locale}/app/notifications`);await page.getByTestId("notification-bell").click();const item=page.locator('[data-notification-id="'+notice.id+'"]');await expect(item).toBeVisible();await item.getByRole("button",{name:messages.Notifications.open,exact:true}).click();await expect(page).toHaveURL(new RegExp("/"+locale+"/app/documents\\?document="+original.id+"&version=1$","u"));await expect(page.getByTestId("document-expiry-load")).toBeVisible();
      await change("",4);await page.getByTestId("document-expiry-load").click();await expect(page.getByTestId("document-expiry-current")).toHaveText(messages.DocumentExpiry.none);expect((await scheduleDocumentExpiryReminders(f.organizationId,{db:f.db})).occurrences).toBe(0);expect(await snapshot()).toEqual(before);await privatePresentation(page,pageErrors);await page.screenshot({path:info.outputPath("actual-version-expiry-history.png"),fullPage:true});
      await page.getByTestId("document-expiry-reason").fill("Unsent private expiry reason "+randomUUID());await context.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event("offline")));await expect(page.getByTestId("document-expiry")).toHaveCount(0);await context.setOffline(false);await page.goto(link);await page.getByTestId("document-expiry-load").click();await expect(page.getByTestId("document-expiry-reason")).toHaveValue("");
      await withTenant(f.db,f.organizationId,tx=>tx.roleAssignment.updateMany({where:{userAccountId:native.actorId,archivedAt:null},data:{validTo:new Date(Date.now()-1000)}}));await page.evaluate(()=>window.dispatchEvent(new Event("focus")));await expect(page.getByTestId("document-expiry")).toHaveCount(0);expect(await snapshot()).toEqual(before);
    }finally{await f.db.$disconnect();}
  });

  test(`Version-bound retention tags recover once, preserve exact finances and expose private policy context in ${locale}`,async({page,context},info)=>{
    test.skip(!process.env.DATABASE_URL,"Dedicated native PostgreSQL required");test.setTimeout(240000);
    const f=await openFieldFixture(page,info,locale),pageErrors:string[]=[],messages={en,fr,ar}[locale];page.on("pageerror",error=>pageErrors.push(error.name));
    try{
      const native=await withTenant(f.db,f.organizationId,async tx=>{
        const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),actorId=task.assignedToUserAccountId!,account=await tx.userAccount.findUniqueOrThrow({where:{id:actorId}}),property=await tx.property.findUniqueOrThrow({where:{id:task.propertyId}});
        const role=await tx.role.create({data:{organizationId:f.organizationId,key:"retention_acceptance_"+randomUUID(),name:"Explicit independent document retention acceptance"}}),keys=["document:view","document:create","document:export","document:edit","property:view","property:export","financial_transaction:view","financial_transaction:export","property_finance:view","property_finance:export","config_rule:view","config_rule:configure"],permissions=await tx.permission.findMany({where:{organizationId:f.organizationId,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);
        await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}))});await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:actorId,personId:account.personId,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
        const typeKey="retention_"+randomUUID().replaceAll("-",""),rules=new ConfigRuleRepository(tx,f.organizationId);
        await rules.createVersion({key:"documents.archive",scopeType:"property",scopeId:property.id,effectiveFrom:new Date("2020-01-01"),createdBy:actorId,reason:"Actual private retention document source acceptance",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:1,upload_admission:{window_seconds:3600,max_requests:100},types:[{key:typeKey,category:"INVOICE",labels:{en:"Retained retention evidence",fr:"Justificatif d’échéance conservé",ar:"إثبات تاريخ الانتهاء المحفوظ"},sources:["FINANCIAL_TRANSACTION"],privacy:["financial"],content_types:["application/pdf"],max_bytes:1048576}]}});
        await rules.createVersion({key:"documents.retention",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:actorId,reason:"Explicit actual browser retention policy",value:{source:"NATIVE_DOCUMENT_VERSIONS",artifact_inheritance:"ORIGINAL_SIGNED_VERSION",archive_tagging:"ALLOW",type_keys:[typeKey],change_admission:{window_seconds:3600,max_requests:100},tags:[{key:"hold",labels:{en:"Retain under review",fr:"Conserver pendant examen",ar:"الاحتفاظ أثناء المراجعة"},blocks_disposition:true,policy_references:["Explicit entered policy reference A"]},{key:"review",labels:{en:"Policy review",fr:"Examen de la politique",ar:"مراجعة السياسة"},blocks_disposition:false,policy_references:["Explicit entered policy reference B"]}]}});
        return{actorId,property,typeKey,roleId:role.id};
      }),journal=await withTenant(f.db,f.organizationId,async tx=>{
        const finance=new FinanceRepository(tx,f.organizationId),bank=await finance.ensureLedgerAccount({code:"RETENTION_BROWSER_"+randomUUID().replaceAll("-","").slice(0,12).toUpperCase(),name:"Actual retention custody",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Actual immutable owner claim",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),amount=Money.of("9007199254740993.07","MAD"),dimensions={property_id:native.property.id};
        return finance.createFinancialTransaction({reference:"RETENTION-BROWSER:"+randomUUID(),description:"Exact retained document retention financial source",idempotencyKey:randomUUID(),createdBy:native.actorId,occurredAt:await finance.clock(),postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"OWNER_REVENUE",dimensions},{ledgerAccountId:claim.id,side:"CREDIT",amount,bucket:"OWNER_REVENUE",dimensions}]});
      });
      await page.goto(`/${locale}/app/documents`);await chooseSource(page,"FINANCIAL_TRANSACTION",journal.reference);const pdf=await originalPdf(),title="Actual private retention original "+randomUUID(),file={name:"retained-retention-original.pdf",mimeType:"application/pdf",buffer:pdf};await fillFile(page,file,title,"Retain the original immutable financial retention document");await page.getByTestId("document-save").click();await expect(page.getByTestId("document-history").getByRole("heading",{name:title,exact:true})).toBeVisible();
      const original=await withTenant(f.db,f.organizationId,tx=>tx.document.findFirstOrThrow({where:{createdBy:native.actorId,typeKey:native.typeKey},include:{versions:{orderBy:{number:"desc"}}}})),version=original.versions[0],snapshot=()=>withTenant(f.db,f.organizationId,tx=>tx.$queryRaw`SELECT 'document' AS kind,t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM document t WHERE organization_id=${f.organizationId}::uuid AND id=${original.id}::uuid UNION ALL SELECT 'version',t.id::text,t.xmin::text,md5(to_jsonb(t)::text) FROM document_version t WHERE organization_id=${f.organizationId}::uuid AND document_id=${original.id}::uuid UNION ALL SELECT 'journal',t.id::text,t.xmin::text,md5(to_jsonb(t)::text) FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid AND id=${journal.id}::uuid UNION ALL SELECT 'posting',t.id::text,t.xmin::text,md5(to_jsonb(t)::text) FROM posting t WHERE organization_id=${f.organizationId}::uuid AND transaction_id=${journal.id}::uuid ORDER BY kind,id`),before=await snapshot(),link=`/${locale}/app/documents?document=${original.id}&version=1`;
      await page.getByTestId("document-open-retention").click();await expect(page.getByTestId("document-retention").getByRole("heading",{name:messages.DocumentRetention.title,exact:true})).toBeVisible();await page.getByTestId("document-retention-load").click();await expect(page.getByTestId("document-retention-current")).toHaveText(messages.DocumentRetention.cleared);
      const privateReason="Private explicit retention reason "+randomUUID();await page.getByTestId("document-retention-tag-hold").check();await page.getByTestId("document-retention-reason").fill(privateReason);await page.getByTestId("document-retention-review").click();await expect(page.getByTestId("document-retention-reviewed")).toBeVisible();
      let admissionPosts=0;const admitted=acknowledgementBarrier();await page.route("**/api/documents/retention/admit",async route=>{admissionPosts++;try{expect(await forwardBrowserPostOnce(route.request())).toBe(200);await route.abort();admitted.resolve();}catch(error){admitted.reject(error);throw error;}});await page.getByTestId("document-retention-admit").click();await admitted.promise;await expect(page.getByTestId("document-retention-recover")).toBeEnabled();
      const saved=await withTenant(f.db,f.organizationId,tx=>tx.documentRetentionRevision.findFirstOrThrow({where:{versionId:version.id}})),nonceKey="alvillas:document-retention:"+f.organizationId+"."+native.actorId+":"+version.id,storage=await page.evaluate(()=>({session:{...sessionStorage},local:{...localStorage}}));expect(storage.session[nonceKey]).toBe(saved.commandKey);for(const value of[privateReason,title,"9007199254740993.07"])expect(JSON.stringify(storage)).not.toContain(value);expect(admissionPosts).toBe(1);await page.unroute("**/api/documents/retention/admit");
      await page.goto(link);await page.getByTestId("document-open-retention").click();await expect(page.getByTestId("document-retention-recover")).toBeEnabled();await page.getByTestId("document-retention-recover").click();await expect(page.getByTestId("document-retention-saved")).toBeVisible();expect(await page.evaluate(key=>sessionStorage.getItem(key),nonceKey)).toBeNull();expect(await withTenant(f.db,f.organizationId,tx=>tx.documentRetentionRevision.count({where:{versionId:version.id}}))).toBe(1);
      await page.getByTestId("document-retention-load").click();await expect(page.getByTestId("document-retention-tag-hold")).toBeChecked();await page.getByTestId("document-retention-context").click();await expect(page.getByTestId("document-retention-policy-context")).toContainText(messages.DocumentRetention.hold);await expect(page.getByTestId("document-retention-policy-context")).toContainText("Explicit entered policy reference A");await expect(page.getByTestId("document-retention-policy-context")).toContainText(messages.DocumentRetention.policyGuidance);
      const change=async(keys:string[],number:number)=>{await page.getByTestId("document-retention-load").click();await expect(page.getByTestId("document-retention-tag-hold")).toBeEnabled();for(const key of["hold","review"])await page.getByTestId("document-retention-tag-"+key).setChecked(keys.includes(key));await page.getByTestId("document-retention-reason").fill("Retain explicit immutable governance correction "+number);await page.getByTestId("document-retention-review").click();await expect(page.getByTestId("document-retention-reviewed")).toBeVisible();await page.getByTestId("document-retention-admit").click();await expect(page.getByTestId("document-retention-saved")).toHaveText(messages.DocumentRetention.saved.replace("{number}",new Intl.NumberFormat(locale).format(number)));};
      await change(["review"],2);await change([],3);await page.getByTestId("document-retention-load").click();await expect(page.getByTestId("document-retention-current")).toHaveText(messages.DocumentRetention.cleared);await page.getByTestId("document-retention-context").click();await expect(page.getByTestId("document-retention-policy-context")).toContainText(messages.DocumentRetention.descriptive);await expect(page.getByTestId("document-retention-policy-context")).toContainText(messages.DocumentRetention.policyGuidance);
      const revisions=await withTenant(f.db,f.organizationId,tx=>tx.documentRetentionRevision.findMany({where:{versionId:version.id},orderBy:{number:"asc"}}));expect(revisions.map(row=>row.tagKeys)).toEqual([["hold"],["review"],[]]);expect(revisions[1].previousId).toBe(revisions[0].id);expect(revisions[2].previousId).toBe(revisions[1].id);expect(await snapshot()).toEqual(before);await privatePresentation(page,pageErrors);await page.screenshot({path:info.outputPath("actual-version-retention-history.png"),fullPage:true});
      await page.getByTestId("document-retention-reason").fill("Unsent private retention reason "+randomUUID());await context.setOffline(true);await page.evaluate(()=>window.dispatchEvent(new Event("offline")));await expect(page.getByTestId("document-retention")).toHaveCount(0);await context.setOffline(false);await page.goto(link);await page.getByTestId("document-open-retention").click();await page.getByTestId("document-retention-load").click();await expect(page.getByTestId("document-retention-reason")).toHaveValue("");
      await withTenant(f.db,f.organizationId,async tx=>{const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.organizationId,key:"financial_transaction:view"}});await tx.rolePermission.deleteMany({where:{organizationId:f.organizationId,roleId:native.roleId,permissionId:permission.id}});});
      const blocked=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/documents/retention/policy-context"&&response.request().method()==="POST");await page.getByTestId("document-retention-context").click();expect((await blocked).status()).toBe(403);await expect(page.getByTestId("document-retention")).toHaveCount(0);expect(await snapshot()).toEqual(before);
    }finally{await f.db.$disconnect();}
  });

  test(`All approved document types retain private native sources and localized classification in ${locale}`, async ({page},info)=>{
    test.skip(!process.env.DATABASE_URL,"Dedicated native PostgreSQL required");test.setTimeout(240000);
    const f=await openFieldFixture(page,info,locale),pageErrors:string[]=[];page.on("pageerror",error=>pageErrors.push(error.name));
    try{
      const native=await withTenant(f.db,f.organizationId,async tx=>{
        const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),actorId=task.assignedToUserAccountId!,account=await tx.userAccount.findUniqueOrThrow({where:{id:actorId}}),property=await tx.property.findUniqueOrThrow({where:{id:task.propertyId}}),organization=await tx.organization.findUniqueOrThrow({where:{id:f.organizationId}});
        if(!account.personId)throw Error("Actual native document actor person required");
        const role=await tx.role.create({data:{organizationId:f.organizationId,key:"typed_documents_"+randomUUID(),name:"Explicit independent native document type acceptance"}}),keys=["document:view","document:create","document:export","organization:view","organization:export","property:view","property:export","owner:view","owner:export","guest:view","guest:export","supplier:view","supplier:create","supplier:export","team_member:view","team_member:export","staff_document:view","staff_document:export","financial_transaction:view","financial_transaction:export","property_finance:view","property_finance:export"],permissions=await tx.permission.findMany({where:{organizationId:f.organizationId,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);
        await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.organizationId,roleId:role.id,permissionId:permission.id}))});
        await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:actorId,personId:account.personId,roleId:role.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
        const owner=await tx.owner.create({data:{organizationId:f.organizationId,displayName:"Actual document owner "+randomUUID()}}),guest=await tx.guestRecord.create({data:{organizationId:f.organizationId,displayName:"Actual document guest "+randomUUID()}}),staff=await tx.person.create({data:{organizationId:f.organizationId,displayName:"Actual document staff "+randomUUID()}});
        return{actorId,personId:account.personId,property,organization,owner,guest,staff};
      }),ctx={organizationId:f.organizationId,actorId:native.actorId,authContext:{...await authContextForAccount(f.organizationId,native.actorId,{db:f.db}),personId:native.personId}},supplier=await createSupplier(ctx,{displayName:"Actual document supplier "+randomUUID(),category:"Contract services",idempotencyKey:randomUUID(),reason:"Create independently authorized native supplier for document acceptance"},{db:f.db}),supplierRow=await withTenant(f.db,f.organizationId,tx=>tx.supplier.findUniqueOrThrow({where:{id:supplier.id}})),journal=await withTenant(f.db,f.organizationId,async tx=>{
        const finance=new FinanceRepository(tx,f.organizationId),bank=await finance.ensureLedgerAccount({code:"TYPED_DOCUMENT_BANK",name:"Native document custody",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Native document ownership",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),amount=Money.of("9007199254740993.07","MAD"),dimensions={property_id:native.property.id};
        return finance.createFinancialTransaction({reference:"DOC-TYPES:"+randomUUID(),description:"Original financial evidence for typed documents",idempotencyKey:randomUUID(),createdBy:native.actorId,occurredAt:await finance.clock(),postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"OWNER_REVENUE",dimensions},{ledgerAccountId:claim.id,side:"CREDIT",amount,bucket:"OWNER_REVENUE",dimensions}]});
      });
      type Source={kind:"ORGANIZATION"|"PROPERTY"|"OWNER"|"GUEST"|"SUPPLIER"|"PERSON"|"FINANCIAL_TRANSACTION";id:string;label:string};
      const owner:Source={kind:"OWNER",id:native.owner.id,label:native.owner.displayName},property:Source={kind:"PROPERTY",id:native.property.id,label:native.property.name},financial:Source={kind:"FINANCIAL_TRANSACTION",id:journal.id,label:journal.reference},sources:Record<typeof documentCategories[number],Source>={OWNER_CONTRACT:owner,AMENDMENT:owner,GUEST_AGREEMENT:{kind:"GUEST",id:native.guest.id,label:native.guest.displayName!},HOUSE_RULES:property,INVOICE:financial,RECEIPT:financial,PROPERTY:property,SUPPLIER:{kind:"SUPPLIER",id:supplier.id,label:supplierRow.displayName},STAFF:{kind:"PERSON",id:native.staff.id,label:native.staff.displayName},REPORT:{kind:"ORGANIZATION",id:f.organizationId,label:native.organization.name}},translations={en,fr,ar};
      const labels=(category:typeof documentCategories[number])=>({en:en.DocumentArchive[`category_${category}`],fr:fr.DocumentArchive[`category_${category}`],ar:ar.DocumentArchive[`category_${category}`]});
      await withTenant(f.db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"documents.archive",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:native.actorId,reason:"Explicit approved native document categories and separate privacy",value:{source:"NATIVE_DOCUMENT_ARCHIVE",encryption:"APP_MANAGED_AEAD",history:"APPEND_ONLY",downloads:"AUTHORIZED_SERVER_PROXY",storage_url_seconds:1,upload_admission:{window_seconds:3600,max_requests:100},types:documentCategories.map(category=>({key:"approved_"+category.toLowerCase(),category,labels:labels(category),sources:[sources[category].kind],privacy:category==="INVOICE"||category==="RECEIPT"?["financial"]:["sensitive"],content_types:["application/pdf"],max_bytes:1048576}))}}));
      const moneyRows=()=>withTenant(f.db,f.organizationId,tx=>tx.$queryRaw`SELECT t.id::text,t.xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t WHERE t.organization_id=${f.organizationId}::uuid UNION ALL SELECT p.id::text,p.xmin::text,md5(to_jsonb(p)::text) FROM posting p WHERE p.organization_id=${f.organizationId}::uuid ORDER BY id`),before=await moneyRows(),pdf=await originalPdf();
      await page.goto(`/${locale}/app/documents`);
      for(const category of documentCategories){
        const source=sources[category],label=translations[locale].DocumentArchive[`category_${category}`];await chooseSource(page,source.kind,source.label);await page.getByTestId("document-type").selectOption("approved_"+category.toLowerCase());
        await expect(page.getByTestId("document-file-editor").getByTestId("document-category")).toHaveText(label);
        const file={name:category.toLowerCase()+".pdf",mimeType:"application/pdf",buffer:pdf},title=label+" "+randomUUID();await fillFile(page,file,title,"Retain actual native source and configured classification");await page.getByTestId("document-save").click();
        await expect(page.getByTestId("document-history").getByRole("heading",{name:title,exact:true})).toBeVisible();await expect(page.getByTestId("document-history").getByTestId("document-category")).toHaveText(label);await expect(page.getByTestId("document-version")).toHaveCount(1);await downloadFile(page,file.name,pdf);
      }
      expect(await moneyRows()).toEqual(before);await privatePresentation(page,pageErrors);await page.screenshot({path:info.outputPath("approved-native-document-types.png"),fullPage:true});
    }finally{await f.db.$disconnect();}
  });
}
