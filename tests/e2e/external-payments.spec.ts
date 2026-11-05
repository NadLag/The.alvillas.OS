import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { guestDepositPolicySchema } from "@/platform/config/guest-deposit-policy";
import { Money } from "@/platform/money/money";
import { executeExternalPaymentCaptureReference, externalPaymentCaptureRequested } from "@/modules/finance/application/external-payment-service";
import { externalPaymentCommandInput } from "@/modules/finance/domain/external-payment-command";
import { externalRefundCommandInput } from "@/modules/finance/domain/external-payment-refund-command";
import { executeExternalPaymentRefundReference, externalPaymentRefundRequested } from "@/modules/finance/application/external-payment-refund-service";
import { openGuestPaymentFixture, paymentBrowserMethods } from "./support/guest-payment-fixture";
import { paypalHttpFixture } from "./support/paypal-http-fixture";
import { acknowledgementBarrier } from "./support/acknowledgement-barrier";
import { forwardBrowserPostOnce } from "./support/forward-browser-post";

test.use({ timezoneId: "America/Denver", actionTimeout: 30000, navigationTimeout: 60000 });
type Fixture = Awaited<ReturnType<typeof openGuestPaymentFixture>>;
async function configure(f: Fixture, refunds = false) {
  return withTenant(f.db, f.organizationId, async tx => {
    const finance = new FinanceRepository(tx, f.organizationId), merchant = await finance.ensureLedgerAccount({ code: "PAYPAL_BROWSER_" + f.marker.toUpperCase(), name: "Original PayPal merchant " + f.marker, accountType: "ASSET_LOCATION", normalSide: "DEBIT" }), rules = new ConfigRuleRepository(tx, f.organizationId),
      current = await rules.resolve({ key: "finance.guest_deposits", scopes: [{ scopeType: "organization", scopeId: null }, { scopeType: "property", scopeId: f.setup.propertyId }], asOf: await finance.clock() });
    if (!current) throw Error("Actual original guest receipt policy required");
    const labels = { en: "Original PayPal payment", fr: "Paiement PayPal initial", ar: "دفعة باي بال الأصلية" }, policy = guestDepositPolicySchema.parse(current.value);
    await rules.createVersion({ key: "finance.guest_deposits", scopeType: "property", scopeId: f.setup.propertyId, effectiveFrom: new Date("2020-01-01"), createdBy: f.setup.actorId,
      value: { ...policy, receipt_account_codes: [...policy.receipt_account_codes, merchant.code], refund_account_codes: refunds ? [...policy.refund_account_codes, merchant.code] : policy.refund_account_codes,
        payment_methods: [...policy.payment_methods, { key: "original-paypal", labels }] }, reason: "Explicit original optional merchant payment receipt policy" });
    await rules.createVersion({ key: "finance.payment_methods", scopeType: "property", scopeId: f.setup.propertyId, effectiveFrom: new Date("2020-01-01"), createdBy: f.setup.actorId,
      value: { methods: [...paymentBrowserMethods.methods, { key: "original-paypal", labels, adapter: "paypal", enabled: true, currencies: ["MAD"], provider_account_code: merchant.code }] }, reason: "Explicit original optional provider and physical merchant location" });
    return merchant;
  });
}
async function prepare(page: Page, f: Fixture, accountId: string, orderId: string) {
  await page.getByTestId("deposit-create-open").click(); await page.getByTestId("deposit-source-open").filter({ hasText: f.setup.propertyName }).click();
  await page.getByTestId("deposit-kind").selectOption("stay"); await page.getByTestId("deposit-received-at").fill(f.receivedAt); await page.getByTestId("deposit-account").selectOption(accountId);
  await page.getByTestId("deposit-amount").fill("0.07"); await page.getByTestId("deposit-currency").selectOption("MAD"); await page.getByTestId("deposit-method").selectOption("original-paypal");
  await page.getByTestId("deposit-facts").locator('[name="reference"]').fill(orderId); await page.getByTestId("deposit-purpose").fill("Original external guest funds " + f.marker); await page.getByTestId("deposit-prepare").click();
  await expect(page.getByTestId("external-capture-review")).toBeVisible(); await page.getByTestId("external-capture-reason").fill("Capture this exact original reviewed order into its actual merchant location"); await page.getByTestId("external-capture-confirm").check();
}
function acknowledgement(page: Page, operation: "CAPTURE" | "ADMIT" | "PREPARE_FEE") {
  return page.waitForResponse(response => new URL(response.url()).pathname === "/api/finance/external-payments/command" && response.request().method() === "POST" &&
    (response.request().postDataJSON() as { operation?: string }).operation === operation);
}

for (const locale of ["en", "fr", "ar"] as const) for (const fee of ["0.00", "0.02"] as const) test(`retains original external capture, ${fee === "0.00" ? "lost acknowledgements" : "approved fee and net"}, and history in ${locale}`, async ({ page }, info) => {
  test.setTimeout(240000);
  const target = new URL(process.env.DATABASE_URL!); if (!["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned browser financial acceptance database required");
  const f = await openGuestPaymentFixture(page, info, locale, { "finance.expense_treatment": { default_treatment: "OWNER_PAID" }, "finance.approval_thresholds": { thresholds: [] } }), orderId = "BROWSER_ORDER_" + randomUUID(), gateway = await paypalHttpFixture(orderId, fee), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  try {
    const merchant = await configure(f), url = `/${locale}/app/finance/guest-deposits`; await page.goto(url); await prepare(page, f, merchant.id, orderId);
    if (fee === "0.00") {
      const lost = acknowledgementBarrier(); await page.route("**/api/finance/external-payments/command", async route => {
        const command = externalPaymentCommandInput.parse(route.request().postDataJSON()); if (command.operation !== "CAPTURE") { await route.continue(); return; }
        try { expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lost.resolve(); } catch (error) { lost.reject(error); throw error; }
      }); await page.getByTestId("external-capture-submit").click(); await lost.promise; await page.unroute("**/api/finance/external-payments/command"); await page.reload();
    } else { const received = acknowledgement(page, "CAPTURE"); await page.getByTestId("external-capture-submit").click(); expect((await received).ok()).toBe(true); }
    const source = await withTenant(f.db, f.organizationId, async tx => {
      const intent = await tx.externalPaymentIntent.findFirstOrThrow({ where: { organizationId: f.organizationId, orderId } }), event = await tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, type: externalPaymentCaptureRequested, payload: { path: ["intentId"], equals: intent.id } } });
      expect(await tx.guestPaymentReceipt.count({ where: { organizationId: f.organizationId, depositId: intent.idempotencyKey } })).toBe(0); return { intent, event };
    });
    await executeExternalPaymentCaptureReference({ organizationId: f.organizationId, outboxEventId: source.event.id }, { db: f.db, provider: gateway.provider });
    await expect(page.getByTestId("external-payment-admission")).toBeVisible(); await page.reload(); await expect(page.getByTestId("external-payment-admission")).toBeVisible();
    expect(gateway.facts()).toMatchObject({ posts: 1, lookups: 1 });
    if (fee === "0.02") {
      await page.getByTestId("external-fee-category").fill("provider_fee"); await page.getByTestId("external-fee-purpose").fill("Actual original provider deduction " + f.marker); await page.getByTestId("external-fee-reason").fill("Apply the booking's retained expense treatment and approval rules");
      const prepared = acknowledgement(page, "PREPARE_FEE"); await page.getByTestId("external-fee-submit").click(); expect((await prepared).ok()).toBe(true); await page.getByTestId("external-fee-link").click();
      await page.getByTestId("expense-submit-reason").fill("Approve the actual original provider deduction under configured original rules"); await page.getByTestId("expense-submit").click(); await expect(page.getByTestId("expense-post-form")).toBeVisible();
      await page.goto(url); await expect(page.getByTestId("external-payment-admission")).toBeVisible();
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
    await page.getByTestId("external-admission-reason").fill("Record the original guest liability, actual merchant net and any approved provider deduction"); await page.getByTestId("external-admission-confirm").check();
    if (fee === "0.00") {
      const lost = acknowledgementBarrier(); await page.route("**/api/finance/external-payments/command", async route => {
        try { expect(externalPaymentCommandInput.parse(route.request().postDataJSON()).operation).toBe("ADMIT"); expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lost.resolve(); } catch (error) { lost.reject(error); throw error; }
      }); await page.getByTestId("external-admission-submit").click(); await lost.promise; await page.unroute("**/api/finance/external-payments/command"); await page.reload();
    } else { const admitted = acknowledgement(page, "ADMIT"); await page.getByTestId("external-admission-submit").click(); expect((await admitted).ok()).toBe(true); }
    await expect(page.getByTestId("deposit-outstanding")).toBeVisible();
    const proof = await withTenant(f.db, f.organizationId, async tx => ({ receipts: await tx.guestPaymentReceipt.findMany({ where: { organizationId: f.organizationId, depositId: source.intent.idempotencyKey }, include: { transaction: true } }),
      capture: await tx.externalPaymentCapture.findFirstOrThrow({ where: { organizationId: f.organizationId, intentId: source.intent.id } }), postings: await tx.posting.findMany({ where: { organizationId: f.organizationId, ledgerAccountId: merchant.id } }) }));
    expect(proof.receipts).toHaveLength(1); expect(proof.receipts[0].amount.toFixed(2)).toBe("0.07"); expect(proof.receipts[0].accountId).toBe(merchant.id); expect(proof.receipts[0].transaction.occurredAt).toEqual(proof.capture.capturedAt);
    const net = proof.postings.reduce((value, posting) => posting.side === "DEBIT" ? value.add(Money.of(posting.amount.toString(), posting.currency)) : value.subtract(Money.of(posting.amount.toString(), posting.currency)), Money.zero("MAD")); expect(net.toJSON()).toEqual({ amount: fee === "0.00" ? "0.07" : "0.05", currency: "MAD" });
    expect(gateway.facts()).toMatchObject({ posts: 1, lookups: 1 }); expect(errors).toEqual([]);
  } finally { await gateway.close(); await f.db.$disconnect(); }
});

for (const locale of ["en", "fr", "ar"] as const) test(`refunds original captured guest funds partially and fully with durable acknowledgement recovery in ${locale}`, async ({ page }, info) => {
  test.setTimeout(240000);
  const target = new URL(process.env.DATABASE_URL!); if (!["localhost", "127.0.0.1"].includes(target.hostname) || !(target.pathname.startsWith("/alvillas_automation_") || process.env.GITHUB_ACTIONS === "true" && target.pathname === "/alvillas_os")) throw Error("Owned browser financial acceptance database required");
  const f = await openGuestPaymentFixture(page, info, locale), orderId = "REFUND_ORDER_" + randomUUID(), gateway = await paypalHttpFixture(orderId), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  try {
    const merchant = await configure(f);
    await withTenant(f.db, f.organizationId, async tx => {
      const finance = new FinanceRepository(tx, f.organizationId), rules = new ConfigRuleRepository(tx, f.organizationId), current = await rules.resolve({ key: "finance.guest_deposits", scopes: [{ scopeType: "organization", scopeId: null }, { scopeType: "property", scopeId: f.setup.propertyId }], asOf: await finance.clock() });
      if (!current) throw Error("Original merchant refund policy required"); const policy = guestDepositPolicySchema.parse(current.value);
      await rules.createVersion({ key: "finance.guest_deposits", scopeType: "property", scopeId: f.setup.propertyId, effectiveFrom: new Date("2020-01-01"), createdBy: f.setup.actorId,
        value: { ...policy, refund_account_codes: [...policy.refund_account_codes, merchant.code] }, reason: "Authorize refunds from the actual original merchant account" });
    });
    await page.goto(`/${locale}/app/finance/guest-deposits`); await prepare(page, f, merchant.id, orderId);
    const captured = acknowledgement(page, "CAPTURE"); await page.getByTestId("external-capture-submit").click(); expect((await captured).ok()).toBe(true);
    const source = await withTenant(f.db, f.organizationId, async tx => {
      const intent = await tx.externalPaymentIntent.findFirstOrThrow({ where: { organizationId: f.organizationId, orderId } }), event = await tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, type: externalPaymentCaptureRequested, payload: { path: ["intentId"], equals: intent.id } } }); return { intent, event };
    });
    await executeExternalPaymentCaptureReference({ organizationId: f.organizationId, outboxEventId: source.event.id }, { db: f.db, provider: gateway.provider });
    await expect(page.getByTestId("external-payment-admission")).toBeVisible(); await page.getByTestId("external-admission-reason").fill("Record the verified original guest funds for refund acceptance"); await page.getByTestId("external-admission-confirm").check();
    const admitted = acknowledgement(page, "ADMIT"); await page.getByTestId("external-admission-submit").click(); expect((await admitted).ok()).toBe(true); await expect(page.getByTestId("deposit-outstanding")).toBeVisible();
    await page.getByTestId("deposit-refund-open").click(); await page.getByTestId("deposit-amount").fill("0.01"); await page.getByTestId("deposit-account").selectOption(merchant.id); await page.getByTestId("deposit-purpose").fill("Cancel this exact original unsent refund " + f.marker); await page.getByTestId("deposit-prepare").click();
    await page.getByTestId("external-refund-reason").fill("Retain the original queued refund for verified cancellation acceptance"); await page.getByTestId("external-refund-confirm").check();
    const queued = page.waitForResponse(response => new URL(response.url()).pathname === "/api/finance/external-payments/refunds/command" && (response.request().postDataJSON() as { operation?: string }).operation === "REQUEST");
    await page.getByTestId("external-refund-submit").click(); expect((await queued).ok()).toBe(true); await page.getByTestId("external-refund-cancel-reason").fill("Cancel the original request before any provider attempt can begin"); await page.getByTestId("external-refund-cancel-confirm").check();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const cancellation = await withTenant(f.db, f.organizationId, async tx => {
      const intent = await tx.externalPaymentRefundIntent.findFirstOrThrow({ where: { organizationId: f.organizationId, depositId: source.intent.idempotencyKey, amount: "0.01" } }), event = await tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, type: externalPaymentRefundRequested, payload: { path: ["intentId"], equals: intent.id } } }); return { intent, event };
    }), lostCancellation = acknowledgementBarrier();
    await page.route("**/api/finance/external-payments/refunds/command", async route => {
      try { expect(externalRefundCommandInput.parse(route.request().postDataJSON()).operation).toBe("CANCEL"); expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lostCancellation.resolve(); } catch (error) { lostCancellation.reject(error); throw error; }
    });
    await page.getByTestId("external-refund-cancel-submit").click(); await lostCancellation.promise; await page.unroute("**/api/finance/external-payments/refunds/command"); await page.reload();
    await page.getByTestId("deposit-open").filter({ hasText: f.setup.propertyName }).click(); await expect(page.getByTestId("deposit-outstanding")).toBeVisible();
    expect(await executeExternalPaymentRefundReference({ organizationId: f.organizationId, outboxEventId: cancellation.event.id }, { db: f.db, provider: gateway.provider })).toMatchObject({ state: "RELEASED" });
    expect(gateway.facts()).toMatchObject({ refundPosts: 0, refundLookups: 0 }); expect(await withTenant(f.db, f.organizationId, tx => tx.financialTransaction.count({ where: { organizationId: f.organizationId, idempotencyKey: "guest-deposit:" + cancellation.intent.idempotencyKey } }))).toBe(0);
    for (const amount of ["0.03", "0.04"]) {
      await page.getByTestId("deposit-refund-open").click(); await page.getByTestId("deposit-amount").fill(amount); await page.getByTestId("deposit-account").selectOption(merchant.id);
      await expect(page.getByTestId("deposit-method")).toHaveValue("original-paypal"); await expect(page.getByTestId("deposit-method")).toBeDisabled(); await expect(page.getByTestId("deposit-currency")).toBeDisabled();
      await page.getByTestId("deposit-purpose").fill("Actual original guest refund " + amount + " " + f.marker); await page.getByTestId("deposit-prepare").click();
      await expect(page.getByTestId("external-refund-review")).toBeVisible(); await expect(page.getByTestId("external-refund-original-deposit")).toContainText(f.setup.propertyName); await page.getByTestId("external-refund-reason").fill("Return only the reviewed original guest funds through the provider"); await page.getByTestId("external-refund-confirm").check();
      const lost = acknowledgementBarrier(); await page.route("**/api/finance/external-payments/refunds/command", async route => {
        try { expect(externalRefundCommandInput.parse(route.request().postDataJSON()).operation).toBe("REQUEST"); expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lost.resolve(); } catch (error) { lost.reject(error); throw error; }
      });
      await page.getByTestId("external-refund-submit").click(); await lost.promise; await page.unroute("**/api/finance/external-payments/refunds/command"); await page.reload();
      const refund = await withTenant(f.db, f.organizationId, async tx => {
        const intent = await tx.externalPaymentRefundIntent.findFirstOrThrow({ where: { organizationId: f.organizationId, depositId: source.intent.idempotencyKey, amount } }), event = await tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, type: externalPaymentRefundRequested, payload: { path: ["intentId"], equals: intent.id } } });
        expect(await tx.financialTransaction.count({ where: { organizationId: f.organizationId, idempotencyKey: "guest-deposit:" + intent.idempotencyKey } })).toBe(0); return { intent, event };
      });
      await executeExternalPaymentRefundReference({ organizationId: f.organizationId, outboxEventId: refund.event.id }, { db: f.db, provider: gateway.provider });
      await expect(page.getByTestId("external-refund-admission")).toBeVisible(); await page.reload(); await expect(page.getByTestId("external-refund-admission")).toBeVisible(); await expect(page.getByTestId("external-refund-original-deposit")).toContainText(f.setup.propertyName);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]); await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
      await page.getByTestId("external-refund-admission-confirm").check(); const lostAdmission = acknowledgementBarrier();
      await page.route("**/api/finance/external-payments/refunds/command", async route => {
        try { expect(externalRefundCommandInput.parse(route.request().postDataJSON()).operation).toBe("ADMIT"); expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lostAdmission.resolve(); } catch (error) { lostAdmission.reject(error); throw error; }
      });
      await page.getByTestId("external-refund-admission-submit").click(); await lostAdmission.promise; await page.unroute("**/api/finance/external-payments/refunds/command"); await page.reload();
      await page.getByTestId("deposit-open").filter({ hasText: f.setup.propertyName }).click(); await expect(page.getByTestId("deposit-outstanding")).toBeVisible();
      const proof = await withTenant(f.db, f.organizationId, async tx => ({ journal: await tx.financialTransaction.findFirstOrThrow({ where: { organizationId: f.organizationId, idempotencyKey: "guest-deposit:" + refund.intent.idempotencyKey }, include: { postings: true } }),
        provider: await tx.externalPaymentRefundEvidence.findFirstOrThrow({ where: { organizationId: f.organizationId, identity: { intentId: refund.intent.id } } }) }));
      expect(proof.journal.occurredAt).toEqual(proof.provider.refundedAt); expect(proof.journal.postings.map(row => row.amount.toFixed(2))).toEqual([amount, amount]); await expect(page.getByTestId("deposit-reverse-open")).toHaveCount(0);
    }
    expect(gateway.facts()).toMatchObject({ posts: 1, refundPosts: 2, refunded: { amount: "0.07", currency: "MAD" } }); expect(errors).toEqual([]); await expect(page.getByTestId("deposit-refund-open")).toHaveCount(0);
  } finally { await gateway.close(); await f.db.$disconnect(); }
});

for (const locale of ["en", "fr", "ar"] as const) for (const credit of ["0.01", "0.02"] as const) test(`records original provider fee credits ${credit} with approved remaining cost and refund recovery in ${locale}`, async ({ page }, info) => {
  test.setTimeout(240000);
  const f = await openGuestPaymentFixture(page, info, locale, { "finance.expense_treatment": { default_treatment: "OWNER_PAID" }, "finance.approval_thresholds": { thresholds: [] } }), orderId = "REFUND_FEE_ORDER_" + randomUUID(),
    gateway = await paypalHttpFixture(orderId, "0.02", credit === "0.01" ? ["0.01", "0.01"] : ["0.02", "0.00"]), errors: string[] = [];
  page.on("pageerror", error => errors.push(error.name));
  try {
    const merchant = await configure(f, true), url = `/${locale}/app/finance/guest-deposits`; await page.goto(url); await prepare(page, f, merchant.id, orderId);
    const captured = acknowledgement(page, "CAPTURE"); await page.getByTestId("external-capture-submit").click(); expect((await captured).ok()).toBe(true);
    const source = await withTenant(f.db, f.organizationId, async tx => {
      const intent = await tx.externalPaymentIntent.findFirstOrThrow({ where: { organizationId: f.organizationId, orderId } }), event = await tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, type: externalPaymentCaptureRequested, payload: { path: ["intentId"], equals: intent.id } } }); return { intent, event };
    });
    await executeExternalPaymentCaptureReference({ organizationId: f.organizationId, outboxEventId: source.event.id }, { db: f.db, provider: gateway.provider });
    await expect(page.getByTestId("external-payment-admission")).toBeVisible();
    await page.getByTestId("external-fee-category").fill("provider_fee"); await page.getByTestId("external-fee-purpose").fill("Actual original provider deduction " + f.marker); await page.getByTestId("external-fee-reason").fill("Apply the original expense treatment and configured approval rules");
    const prepared = acknowledgement(page, "PREPARE_FEE"); await page.getByTestId("external-fee-submit").click(); expect((await prepared).ok()).toBe(true); await page.getByTestId("external-fee-link").click();
    await page.getByTestId("expense-submit-reason").fill("Approve the original provider deduction before native capture admission"); await page.getByTestId("expense-submit").click(); await expect(page.getByTestId("expense-post-form")).toBeVisible();
    await page.goto(url); await expect(page.getByTestId("external-payment-admission")).toBeVisible(); await page.getByTestId("external-admission-reason").fill("Record the actual original guest funds and approved fee"); await page.getByTestId("external-admission-confirm").check();
    const admitted = acknowledgement(page, "ADMIT"); await page.getByTestId("external-admission-submit").click(); expect((await admitted).ok()).toBe(true); await expect(page.getByTestId("deposit-outstanding")).toBeVisible();
    const original = await withTenant(f.db, f.organizationId, tx => tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY kind,id`);
    for (const amount of ["0.03", "0.04"]) {
      await page.getByTestId("deposit-refund-open").click(); await page.getByTestId("deposit-amount").fill(amount); await page.getByTestId("deposit-account").selectOption(merchant.id); await page.getByTestId("deposit-purpose").fill("Original guest refund with verified returned fee " + amount + " " + f.marker); await page.getByTestId("deposit-prepare").click();
      await expect(page.getByTestId("external-refund-original-deposit")).toContainText(f.setup.propertyName); await page.getByTestId("external-refund-reason").fill("Return only the original guest funds and verified provider fee credit"); await page.getByTestId("external-refund-confirm").check();
      const requested = page.waitForResponse(response => new URL(response.url()).pathname === "/api/finance/external-payments/refunds/command" && (response.request().postDataJSON() as { operation?: string }).operation === "REQUEST");
      await page.getByTestId("external-refund-submit").click(); expect((await requested).ok()).toBe(true);
      const refund = await withTenant(f.db, f.organizationId, async tx => {
        const intent = await tx.externalPaymentRefundIntent.findFirstOrThrow({ where: { organizationId: f.organizationId, depositId: source.intent.idempotencyKey, amount } }), event = await tx.outboxEvent.findFirstOrThrow({ where: { organizationId: f.organizationId, type: externalPaymentRefundRequested, payload: { path: ["intentId"], equals: intent.id } } }); return { intent, event };
      });
      await executeExternalPaymentRefundReference({ organizationId: f.organizationId, outboxEventId: refund.event.id }, { db: f.db, provider: gateway.provider }); await expect(page.getByTestId("external-refund-admission")).toBeVisible();
      const hasFee = amount === "0.03" || credit === "0.01";
      if (hasFee) {
        await expect(page.getByTestId("external-refund-admission-submit")).toBeDisabled();
        const lost = acknowledgementBarrier(); await page.route("**/api/finance/external-payments/refunds/command", async route => {
          try { expect(externalRefundCommandInput.parse(route.request().postDataJSON()).operation).toBe("PREPARE_FEE"); expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lost.resolve(); } catch (error) { lost.reject(error); throw error; }
        });
        await page.getByTestId("external-refund-prepare-fee").click(); await lost.promise; await page.unroute("**/api/finance/external-payments/refunds/command"); await page.reload(); await expect(page.getByTestId("external-refund-fee-correction")).toBeVisible(); await expect(page.getByTestId("external-refund-prepare-fee")).toHaveCount(0);
        const binding = await withTenant(f.db, f.organizationId, tx => tx.externalPaymentRefundFee.findFirstOrThrow({ where: { organizationId: f.organizationId, refundIntentId: refund.intent.id } }));
        if (binding.correctionExpenseId) {
          await expect(page.getByTestId("external-refund-admission-submit")).toBeDisabled(); const popup = page.waitForEvent("popup"); await page.getByTestId("external-refund-fee-expense").click(); const expense = await popup;
          try {
            await expect(expense.getByTestId("expense-refund-guidance")).toBeVisible(); await expect(expense.getByTestId("expense-edit")).toHaveCount(0); await expect(expense.getByTestId("expense-post-form")).toHaveCount(0);
            await expense.getByTestId("expense-submit-reason").fill("Approve the remaining original cost through its retained agreement and approval rules"); await expense.getByTestId("expense-submit").click(); await expect(expense.getByTestId("expense-submit")).toHaveCount(0); await expect(expense.getByTestId("expense-post-form")).toHaveCount(0);
            expect((await withTenant(f.db, f.organizationId, tx => tx.expense.findFirstOrThrow({ where: { organizationId: f.organizationId, id: binding.correctionExpenseId! } }))).state).toBe("APPROVED");
          } finally { await expense.close(); }
          await page.getByTestId("external-refund-refresh-fee").click();
        } else await expect(page.getByTestId("external-refund-fee-expense")).toHaveCount(0);
      }
      await expect(page.getByTestId("external-refund-admission-confirm")).toBeEnabled(); expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await page.evaluate(() => { document.documentElement.style.zoom = "2"; }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true); await page.evaluate(() => { document.documentElement.style.zoom = "1"; });
      await page.getByTestId("external-refund-admission-confirm").check(); const lost = acknowledgementBarrier(); await page.route("**/api/finance/external-payments/refunds/command", async route => {
        try { expect(externalRefundCommandInput.parse(route.request().postDataJSON()).operation).toBe("ADMIT"); expect(await forwardBrowserPostOnce(route.request())).toBe(200); await route.abort(); lost.resolve(); } catch (error) { lost.reject(error); throw error; }
      });
      await page.getByTestId("external-refund-admission-submit").click(); await lost.promise; await page.unroute("**/api/finance/external-payments/refunds/command"); await page.reload(); await page.getByTestId("deposit-open").filter({ hasText: f.setup.propertyName }).click(); await expect(page.getByTestId("deposit-outstanding")).toBeVisible(); await expect(page.getByTestId("deposit-reverse-open")).toHaveCount(0);
      const fact = await withTenant(f.db, f.organizationId, async tx => ({ journal: await tx.financialTransaction.findFirstOrThrow({ where: { organizationId: f.organizationId, idempotencyKey: "guest-deposit:" + refund.intent.idempotencyKey }, include: { postings: true } }), evidence: await tx.externalPaymentRefundEvidence.findFirstOrThrow({ where: { organizationId: f.organizationId, identity: { intentId: refund.intent.id }, state: "COMPLETED" } }) }));
      expect(fact.journal.sealed).toBe(true); expect(fact.journal.occurredAt).toEqual(fact.evidence.refundedAt); expect(fact.journal.postings.map(row => row.amount.toFixed(2))).toEqual([amount, amount]);
    }
    const proof = await withTenant(f.db, f.organizationId, async tx => ({ history: await tx.$queryRaw<Array<{ kind: string; id: string; xmin: string; body: string }>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t)::text AS body FROM financial_transaction t WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p)::text FROM posting p WHERE organization_id=${f.organizationId}::uuid ORDER BY kind,id`,
      costs: await tx.expense.findMany({ where: { organizationId: f.organizationId, category: "provider_fee" } }), postings: await tx.posting.findMany({ where: { organizationId: f.organizationId, ledgerAccountId: merchant.id } }) }));
    const ids = new Set(original.map(row => row.kind + row.id)); expect(proof.history.filter(row => ids.has(row.kind + row.id))).toEqual(original); expect(proof.costs.every(cost => cost.state === "VOIDED")).toBe(true); expect(proof.costs).toHaveLength(credit === "0.01" ? 2 : 1);
    expect(proof.postings.reduce((total, row) => row.side === "DEBIT" ? total.add(Money.of(row.amount.toString(), row.currency)) : total.subtract(Money.of(row.amount.toString(), row.currency)), Money.zero("MAD")).toJSON().amount).toBe("0.00");
    expect(gateway.facts()).toMatchObject({ posts: 1, refundPosts: 2, refunded: { amount: "0.07", currency: "MAD" }, creditedFee: { amount: "0.02", currency: "MAD" } }); expect(errors).toEqual([]); await expect(page.getByTestId("deposit-refund-open")).toHaveCount(0);
  } finally { await gateway.close(); await f.db.$disconnect(); }
});
