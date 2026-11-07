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
