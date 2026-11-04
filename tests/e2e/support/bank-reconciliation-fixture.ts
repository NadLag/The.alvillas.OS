import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { calendarDateAt } from "@/i18n/format";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { guestDepositReceiptReviewSchema } from "@/modules/finance/domain/guest-deposit-workspace";
import { guestDepositCommandSuccessSchema } from "@/modules/finance/domain/guest-deposit-command";
import { accountingPeriodPolicySchema } from "@/modules/finance/domain/accounting-period";
import type { openFieldFixture } from "./field-fixture";

export async function prepareBankReconciliationFixture(f: Awaited<ReturnType<typeof openFieldFixture>>, marker: string, page: Page) {
  const setup = await withTenant(f.db, f.organizationId, async tx => {
    const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } }), actor = await tx.userAccount.findUniqueOrThrow({ where: { id: task.assignedToUserAccountId! } });
    const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: "Private original matching owner " + marker } });
    await tx.propertyOwner.create({ data: { organizationId: f.organizationId, propertyId: task.propertyId, ownerId: owner.id, shareBps: 10000 } });
    const finance = new FinanceRepository(tx, f.organizationId), bank = await finance.ensureLedgerAccount({ code: "MATCH_BANK_" + marker.toUpperCase(), name: "Actual matching bank " + marker, accountType: "ASSET_LOCATION", normalSide: "DEBIT" }),
      refundBank = await finance.ensureLedgerAccount({ code: "MATCH_REFUND_" + marker.toUpperCase(), name: "Independent actual refund bank " + marker, accountType: "ASSET_LOCATION", normalSide: "DEBIT" }), rules = new ConfigRuleRepository(tx, f.organizationId);
    const labels = { en: "Actual accommodation prepayment", fr: "Acompte réel du séjour", ar: "دفعة الإقامة الفعلية" };
    for (const [key, value] of Object.entries({ "finance.commission": { rate_bps: 2000, basis: "GROSS_ACCOMMODATION", accrual_event: "ON_CHECKOUT" },
      "ops.reservation_task_templates": { tasks: [{ key: "arrival", type: "ARRIVAL_PREPARATION", due: "CHECK_IN", title: labels, checklist: [{ key: "ready", label: labels }] }] },
      "finance.guest_deposits": { source: "ACTUAL_GUEST_RECEIPT", kinds: [{ key: "stay", labels, liability_account_code: "GUEST_PREPAYMENT", application: "ACCOMMODATION_PREPAYMENT" }], receipt_account_codes: [bank.code], refund_account_codes: [refundBank.code],
        receipt_bucket: "GUEST_DEPOSIT_RECEIPT", refund_bucket: "GUEST_DEPOSIT_REFUND", payment_methods: [{ key: "bank_transfer", labels }], refund_limit: "ORIGINAL_UNAPPLIED_UNREFUNDED_LIABILITY", closed_period: "REJECT", correction_date: "CURRENT_OPEN_PERIOD" } }))
      await rules.createVersion({ key, scopeType: "property", scopeId: task.propertyId, effectiveFrom: new Date("2020-01-01"), createdBy: actor.id, value, reason: "Explicit actual original bank receipt and booking acceptance policy" });
    await rules.lockVersion("finance.accounting_periods", "organization", null);
    const now = await finance.clock();
    const calendar = await rules.resolve({ key: "finance.accounting_periods", scopes: [{ scopeType: "organization", scopeId: null }], asOf: now }) ??
      await rules.createVersion({ key: "finance.accounting_periods", scopeType: "organization", effectiveFrom: new Date("2020-01-01"), createdBy: actor.id, value: { timezone: "UTC", allow_early_close: false, max_reopen_seconds: 60 }, reason: "Explicit actual original bank calendar" });
    const bankId = "matching-bank-" + marker, accountId = "matching-account-" + marker;
    await rules.createVersion({ key: "finance.bank_statements", scopeType: "organization", effectiveFrom: now, createdBy: actor.id, value: {
      source: "ORIGINAL_BANK_STATEMENT", accounts: [{ account_code: bank.code, bank_id: bankId, branch_id: null, account_id: accountId, account_type: "CHECKING", currency: "MAD", ofx: true,
        csv: { delimiter: ";", dateFormat: "YYYY-MM-DD", decimalSeparator: ".", groupingSeparator: "", columns: { postedDate: "date", transactionId: "id", reference: "reference", description: "description", currency: "currency", amount: "amount" } } }],
      encoding: "UTF-8", max_bytes: 1000000, max_rows: 5000, matching: { date_window_days: 0, amount_tolerance: "0.00", reference: "NONE", admission: "EXPLICIT_REVIEW", ledger_effect: "NONE" }, source_corrections: "APPEND_AND_REOPEN_REVIEW", duplicate_csv_without_id: "RETAIN_EVERY_ROW"
    }, reason: "Explicit actual bank identity and independent original matching rules" });
    return { actor, bank, refundBank, bankId, accountId, propertyId: task.propertyId, receivedAt: now.toISOString(), date: calendarDateAt(now, accountingPeriodPolicySchema.parse(calendar.value).timezone), ownerName: owner.displayName };
  });
  const guestName = "Actual matching guest " + marker;
  await page.goto("/en/app/reservations"); const booking = page.getByTestId("reservation-create-form");
  await booking.getByTestId("reservation-property").selectOption(setup.propertyId); await booking.getByTestId("reservation-guest-name").fill(guestName); await booking.getByTestId("reservation-guest-email").fill(marker + "@example.test");
  await booking.getByTestId("reservation-source").selectOption("DIRECT"); await booking.getByTestId("reservation-check-in").fill("2030-05-01"); await booking.getByTestId("reservation-check-out").fill("2030-05-04");
  await booking.locator('[name="amount"]').fill("8000.00"); await booking.locator('[name="currency"]').fill("MAD"); await booking.getByTestId("reservation-submit").click(); await expect(page).toHaveURL(/\/en\/app\/operations/u);
  const reservation = await withTenant(f.db, f.organizationId, tx => tx.reservation.findFirstOrThrow({ where: { propertyId: setup.propertyId, linkedguestId: { displayName: guestName } } }));
  const input = { reservationId: reservation.id, kind: "stay", accountId: setup.bank.id, amount: "0.07", currency: "MAD", method: "bank_transfer", receivedAt: setup.receivedAt, externalReference: "actual-bank-" + marker, purpose: "Actual original bank receipt for matching " + marker };
  const headers = { Origin: new URL(page.url()).origin }, reviewed = await page.request.post("/api/finance/guest-deposits/read", { headers, data: { ...input, operation: "REVIEW_RECEIPT" } });
  expect(reviewed.ok()).toBe(true); const review = guestDepositReceiptReviewSchema.parse(await reviewed.json());
  const received = await page.request.post("/api/finance/guest-deposits/command", { headers, data: { operation: "RECEIPT", input: { ...input, reviewFingerprint: review.reviewFingerprint, reason: "Receive actual original guest funds before explicit bank matching" }, idempotencyKey: randomUUID() } });
  expect(received.ok()).toBe(true); const receipt = guestDepositCommandSuccessSchema.parse(await received.json());
  const journal = await withTenant(f.db, f.organizationId, tx => tx.financialTransaction.findUniqueOrThrow({ where: { id: receipt.id } }));
  return { ...setup, receiptId: receipt.id, reference: journal.reference };
}
