import { selectPaymentAccount } from "./support/payment-account-picker";
import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { nextReferenceNumber } from "@/platform/references/reference-number";
import { AccountingPeriodRepository } from "@/modules/finance/infrastructure/accounting-period-repository";
import { formatCurrencyAmount } from "@/i18n/format";
import { ownerLedgerPath } from "@/modules/finance/domain/owner-ledger";
import { openFieldFixture } from "./support/field-fixture";
import { ensureE2EAdmin, e2eEmail, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.use({ timezoneId: "America/Denver", serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native expense approval, posting, reversal and transaction groups in ${locale}`, async ({ page: admin, browser }, info) => {
  test.skip(!process.env.DATABASE_URL, "Real local PostgreSQL is required"); test.setTimeout(420000);
  if (!["localhost", "127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname)) throw new Error("Native expense acceptance requires local PostgreSQL");
  const f = await openFieldFixture(admin, info, "en"), origin = new URL(admin.url()).origin, suffix = randomUUID().slice(0,8);
  const ownerContext = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, viewport: { width: info.project.name === "field-mobile" ? 360 : 1440, height: 900 } });
  const fieldContext = await browser.newContext({ baseURL: origin, storageState: { cookies: [], origins: [] }, viewport: { width: 360, height: 900 } });
  const ownerPage = await ownerContext.newPage(), fieldPage = await fieldContext.newPage(), errors: string[] = [];
  for (const page of [admin, ownerPage, fieldPage]) page.on("pageerror", error => errors.push(error.message));
  const email = e2eEmail(`expense-owner-${locale}-${suffix}`, info.project.name), password = process.env.ADMIN_PASSWORD ?? "correct horse battery staple";
  const phone = `+21266${randomInt(1_000_000,10_000_000)}`, pin = "368247", purpose = `Dedicated native expense ${suffix}`;
  try {
    await ensureE2EAdmin(email, password);
    const setup = await withTenant(f.db, f.organizationId, async tx => {
      await tx.currency.upsert({ where: { code: "MAD" }, update: {}, create: { code: "MAD", name: "Dirham", minorUnit: 2 } });
      const task = await tx.operationTask.findUniqueOrThrow({ where: { id: f.taskId } });
      const owner = await tx.owner.create({ data: { organizationId: f.organizationId, displayName: `Dedicated expense owner ${suffix}` } });
      await tx.propertyOwner.create({ data: { organizationId: f.organizationId, ownerId: owner.id, propertyId: task.propertyId } });
      const bank = await tx.ledgerAccount.create({ data: { organizationId: f.organizationId, code: `EXPENSE_BANK_${suffix.toUpperCase()}`, name: `Dedicated expense bank ${suffix}`, accountType: "ASSET_LOCATION", normalSide: "DEBIT" } });
      const account = await tx.userAccount.findFirstOrThrow({ where: { email, organizationId: f.organizationId } }), role = await tx.role.findFirstOrThrow({ where: { organizationId: f.organizationId, key: "owner" } });
      await tx.roleAssignment.updateMany({ where: { organizationId: f.organizationId, userAccountId: account.id, archivedAt: null }, data: { archivedAt: new Date() } });
      await tx.roleAssignment.create({ data: { organizationId: f.organizationId, userAccountId: account.id, personId: account.personId, roleId: role.id,
        scopeType: "owner", scopeId: owner.id, validFrom: new Date("2020-01-01") } });
      const config = new ConfigRuleRepository(tx, f.organizationId);
      await config.createVersion({ key: "finance.expense_treatment", scopeType: "property", scopeId: task.propertyId, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated native expense agreement", value: { default_treatment: "OWNER_PAID" } });
      await config.createVersion({ key: "finance.approval_thresholds", scopeType: "property", scopeId: task.propertyId, effectiveFrom: new Date("2020-01-01"),
        reason: "Dedicated scoped owner approval", value: { thresholds: [{ key: "native_expense", amount: "100", currency: "MAD", requires_approval_from: ["owner"] }],
          routing: { owner: { roles: [role.id], people: [], assigned: false, channels: ["in_app"] } } } });
      await config.createVersion({key:"finance.accounting_periods",scopeType:"organization",scopeId:null,effectiveFrom:new Date("2000-01-01"),
        reason:"Dedicated native historical accounting calendar",value:{timezone:"Europe/Paris",allow_early_close:false,max_reopen_seconds:60}});
      const periods = new AccountingPeriodRepository(tx, f.organizationId);
      let sourceMonth = "", occupied = 1;
      for (let attempt = 0; attempt < 36 && occupied; attempt++) {
        const reference = await nextReferenceNumber(tx, f.organizationId, "EXP_ADJ_QA");
        const slot = Number(reference.split("-").at(-1));
        sourceMonth = new Date(Date.UTC(2025, -slot, 1)).toISOString().slice(0, 7);
        if (sourceMonth < "2020-01") throw new Error("Historical expense acceptance calendar is exhausted; preserve all existing records");
        const bounds = await periods.bounds(sourceMonth, "Europe/Paris");
        occupied = await tx.financialTransaction.count({ where: { occurredAt: { gte: bounds.startsAt, lt: bounds.endsAt } } }) +
          Number(Boolean(await periods.byMonth(sourceMonth)));
      }
      expect(occupied).toBe(0);
      const bounds = await periods.bounds(sourceMonth, "Europe/Paris");
      expect(await tx.financialTransaction.count({where:{occurredAt:{gte:bounds.startsAt,lt:bounds.endsAt}}})).toBe(0);
      const unrelatedOwner=await tx.owner.create({data:{organizationId:f.organizationId,displayName:`Unrelated private ledger owner ${suffix}`}});
      return { ownerId:owner.id,ownerName:owner.displayName,unrelatedOwnerId:unrelatedOwner.id,propertyId: task.propertyId, bankId: bank.id, ownerAccountId: account.id, ownerRoleId: role.id,sourceMonth,sourceOn:sourceMonth+"-15" };
    });
    await admin.goto("/en/app/identity"); await admin.getByTestId("invite-display-name").fill(`Dedicated expense field ${suffix}`);
    await admin.getByTestId("invite-phone").fill(phone); await admin.getByTestId("invite-role").selectOption("field_staff");
    await admin.getByTestId("invite-scope-type").selectOption("job"); await admin.getByTestId("invite-scope-id").fill(f.taskId);
    await admin.getByTestId("invite-preferred-locale").selectOption(locale); await admin.getByTestId("invite-submit").click();
    const invitation = (await admin.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim(); expect(invitation).toBeTruthy();
    await fieldPage.goto(`/${locale}/activate/${invitation}`); await fieldPage.getByTestId("activation-phone").fill(phone); await fieldPage.getByTestId("activation-pin").fill(pin);
    await fieldPage.getByTestId("activation-submit").click(); await expect(fieldPage).toHaveURL(new RegExp(`/${locale}/login$`, "u"));
    await fieldPage.goto(`/${locale}/login?surface=field`); await fieldPage.getByTestId("login-phone").fill(phone); await fieldPage.getByTestId("login-pin").fill(pin);
    await fieldPage.getByTestId("login-submit").click(); await expect(fieldPage).toHaveURL(new RegExp(`/${locale}/app/field$`, "u"));
    const fieldUser = z.object({ user: z.object({ id: z.uuid() }) }).parse(await (await fieldPage.request.get("/api/auth/session")).json()).user;
    await admin.goto(`/${locale}/app/properties/${setup.propertyId}`); await admin.getByTestId("property-new-expense").click();
    await expect(admin.getByTestId("expense-new-page")).toBeVisible();
    const form = admin.getByTestId("expense-draft-form"); await form.getByTestId("expense-amount").fill("500,25");
    await form.getByTestId("expense-category").fill("maintenance"); await form.getByTestId("expense-purpose").fill(purpose);
    await selectPaymentAccount(form,"expense-funding-account",setup.bankId); await form.getByTestId("expense-occurred-on").fill(setup.sourceOn);
    await form.getByTestId("expense-reason").fill("Dedicated native expense entry");
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await form.getByTestId("expense-create").click(); await expect(admin.getByTestId("expense-detail-page")).toBeVisible();
    const expenseId = new URL(admin.url()).pathname.split("/").at(-1)!;
    await expect(admin.getByTestId("expense-total")).toHaveText(formatCurrencyAmount(locale,"500.25","MAD"));
    const denied = await fieldPage.request.get(`/${locale}/app/expenses/${expenseId}`); expect(denied.status()).toBe(404); expect(await denied.text()).not.toContain(purpose);
    await admin.getByTestId("expense-submit-reason").fill("Dedicated native expense submission review");
    const capture = admin.waitForRequest(request => request.method() === "POST" && Boolean(request.headers()["next-action"]) &&
      new URL(request.url()).pathname.endsWith(`/expenses/${expenseId}`) && Boolean(request.postData()?.includes(expenseId)));
    await admin.getByTestId("expense-submit").click(); const request = await capture;
    await expect(admin.getByTestId("expense-approval-link")).toBeVisible();
    const deniedAction = await fieldPage.request.post(request.url(), { data: request.postDataBuffer()!, headers: { "content-type": request.headers()["content-type"], "next-action": request.headers()["next-action"], accept: "text/x-component", origin } });
    const rejected = await deniedAction.text(); expect(rejected).toContain('"ok":false'); expect(rejected).toContain('"code":"forbidden"');
    const approvalId = await withTenant(f.db, f.organizationId, async tx => {
      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId }, include: { approval: true } });
      expect(expense.state).toBe("PENDING_APPROVAL"); expect(expense.approval).not.toBeNull();
      expect(await tx.outboxEvent.count({ where: { idempotencyKey: `expense:${expenseId}:ExpenseSubmitted` } })).toBe(1);
      expect(await tx.outboxEvent.count({ where: { idempotencyKey: `expense:${expenseId}:ExpenseOverThreshold` } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: expenseId, action: "expense.submitted" } })).toBe(1);
      expect(await tx.auditLog.count({ where: { actorId: fieldUser.id, resourceId: expenseId } })).toBe(0);
      expect(await tx.notification.count({ where: { recipientId: setup.ownerAccountId, targetId: expense.approval!.id, kind: "approval_requested" } })).toBe(1);
      return expense.approval!.id;
    });
    await ownerPage.goto(`/${locale}/login`); await waitForE2EAdminLoginWindow(ownerPage,email);
    await ownerPage.getByTestId("login-email").fill(email); await ownerPage.getByTestId("login-password").fill(password);
    await ownerPage.getByTestId("login-submit").click(); await completeE2EAdminMfa(ownerPage,email); await expect(ownerPage).toHaveURL(/\/app(?:\/|$)/u);
    await ownerPage.goto(`/${locale}/app/approvals/${approvalId}`);
    await expect(ownerPage.getByTestId("approval-page")).toBeVisible();
    await expect(ownerPage.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(ownerPage.getByTestId("approval-approve")).toBeEnabled();
    await expect(ownerPage.getByTestId("approval-financial-summary")).toContainText(formatCurrencyAmount(locale,"500.25","MAD"));
    expect((await new AxeBuilder({ page: ownerPage }).analyze()).violations).toEqual([]);
    await ownerPage.getByTestId("approval-reason").fill("Dedicated scoped owner approves original expense"); await ownerPage.getByTestId("approval-approve").click();
    await expect(ownerPage.getByTestId("approval-approve")).toHaveCount(0);
    await ownerPage.getByTestId("notification-bell").click();
    const resolved = ownerPage.getByTestId("notification-item").filter({ has: ownerPage.getByTestId("notification-resolution") });
    await expect(resolved).toHaveCount(1); await expect(resolved.getByRole("button").first()).toBeEnabled();
    await admin.reload(); await expect(admin.getByTestId("expense-approval-link")).toBeVisible(); await expect(admin.getByTestId("expense-submit-form")).toHaveCount(0);
    await withTenant(f.db, f.organizationId, async tx => {
      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } }); expect(expense.state).toBe("APPROVED"); expect(expense.transactionId).toBeNull();
      expect(await tx.expenseSubmission.count({ where: { expenseId } })).toBe(1);
      expect(await tx.approvalStage.count({ where: { approvalId, state: "APPROVED", decidedBy: setup.ownerAccountId } })).toBe(1);
      expect(await tx.auditLog.count({ where: { resourceId: expenseId, action: "expense.approved" } })).toBe(1);
    });
    await ownerPage.goto(`/${locale}/app/expenses/${expenseId}`);await expect(ownerPage.getByTestId("expense-detail-page")).toBeVisible();
    await expect(ownerPage.getByTestId("expense-post-form")).toHaveCount(0);
    await admin.goto(`/${locale}/app/finance/periods`);
    await admin.getByTestId("accounting-period-month").fill(setup.sourceMonth);await admin.getByTestId("accounting-period-reason").fill("Dedicated reconciled historical expense month");
    await admin.getByTestId("accounting-period-close").getByRole("button").click();
    await admin.waitForURL(new RegExp(`/${locale}/app/finance/periods/[0-9a-f-]+$`, "u"));
    await expect(admin.getByTestId("accounting-period-state")).toHaveAttribute("data-state","CLOSED");
    const closedPeriodId=new URL(admin.url()).pathname.split("/").at(-1)!;
    const sourceSnapshot=await withTenant(f.db,f.organizationId,tx=>tx.accountingPeriodEvent.findFirstOrThrow({where:{periodId:closedPeriodId},orderBy:{version:"desc"}}));
    await admin.goto(`/${locale}/app/expenses/${expenseId}`);
    await expect(admin.getByTestId("expense-source-period-closed")).toBeVisible();
    await expect(admin.getByTestId("expense-current-period")).not.toBeChecked();
    await expect(admin.getByTestId("expense-current-period")).toHaveAttribute("required","");
    await admin.getByTestId("expense-current-period").check();
    await expect(admin.getByTestId("expense-post-form")).toBeVisible();await admin.getByTestId("expense-post-reason").fill("Dedicated accepted bank payment reference");
    const postingRequest=admin.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&
      new URL(request.url()).pathname.endsWith(`/expenses/${expenseId}`)&&Boolean(request.postData()?.includes(expenseId)));
    await admin.getByTestId("expense-post").click();const payment=await postingRequest;
    await expect(admin.getByTestId("expense-post-form")).toHaveCount(0);await expect(admin.getByTestId("expense-detail-page")).toBeVisible();
    const paymentHeaders={"content-type":payment.headers()["content-type"],"next-action":payment.headers()["next-action"],accept:"text/x-component",origin};
    const ownerDenied=await ownerPage.request.post(payment.url(),{data:payment.postDataBuffer()!,headers:paymentHeaders});
    expect(await ownerDenied.text()).toContain('"code":"forbidden"');
    const repeatedPayment=await admin.request.post(payment.url(),{data:payment.postDataBuffer()!,headers:paymentHeaders});
    expect(await repeatedPayment.text()).toContain('"idempotent":true');
    await withTenant(f.db,f.organizationId,async tx=>{
      const expense=await tx.expense.findUniqueOrThrow({where:{id:expenseId}});expect(expense.state).toBe("POSTED");expect(expense.transactionId).not.toBeNull();
      expect(await tx.financialTransaction.count({where:{idempotencyKey:`expense:${expenseId}:posted`}})).toBe(1);
      const lines=await tx.posting.findMany({where:{transactionId:expense.transactionId!}});expect(lines).toHaveLength(2);
      expect(lines.map(line=>({side:line.side,amount:line.amount.toString(),bucket:line.bucket}))).toEqual(expect.arrayContaining([
        {side:"DEBIT",amount:"500.25",bucket:"OWNER_EXPENSE"},{side:"CREDIT",amount:"500.25",bucket:"EXPENSE_PAYMENT"}]));
      expect(await tx.auditLog.count({where:{resourceId:expenseId,action:"expense.posted"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:expenseId,action:"expense.posted",actorId:setup.ownerAccountId}})).toBe(0);
      const adjustment=await tx.accountingPeriodAdjustment.findFirstOrThrow({where:{expenseId}});
      expect(adjustment).toMatchObject({periodId:closedPeriodId,periodEventId:sourceSnapshot.id,transactionId:expense.transactionId});
      expect(expense.occurredOn.toISOString().slice(0,10)).toBe(setup.sourceOn);
      expect((await tx.financialTransaction.findUniqueOrThrow({where:{id:expense.transactionId!}})).occurredAt.toISOString().slice(0,7)).not.toBe(setup.sourceMonth);
      expect(await tx.auditLog.count({where:{action:"finance.period.adjustment_posted",resourceId:expense.transactionId!}})).toBe(1);
      const calendar=await tx.accountingPeriod.findUniqueOrThrow({where:{id:closedPeriodId}});
      expect(await new AccountingPeriodRepository(tx,f.organizationId).snapshot(calendar.startsAt,calendar.endsAt)).toEqual(sourceSnapshot.snapshot);
    });
    await expect(admin.getByTestId("expense-period-adjustment")).toBeVisible();
    await expect(admin.getByRole("heading",{level:1})).toBeVisible();expect((await new AxeBuilder({page:admin}).analyze()).violations).toEqual([]);
    await ownerPage.reload();await expect(ownerPage.getByTestId("expense-void-form")).toHaveCount(0);
    await expect(admin.getByTestId("expense-void-form")).toBeVisible();
    const expenseReturnUrl=admin.url();
    await admin.goto(`/${locale}/app/finance/accounts`);await admin.getByTestId("owner-ledger-entry").click();await expect(admin.getByTestId("owner-ledger-index")).toBeVisible();
    await admin.getByTestId("owner-ledger-search").fill(setup.ownerName);await admin.getByTestId("owner-ledger-search").press("Enter");
    await expect.poll(()=>new URL(admin.url()).searchParams.get("q")).toBe(setup.ownerName);
    const ownerCard=admin.getByRole("heading",{name:setup.ownerName,exact:true}).locator("..");await ownerCard.getByTestId("owner-ledger-open").click();
    await expect(admin.getByTestId("owner-ledger-closing")).toHaveText(formatCurrencyAmount(locale,"-500.25","MAD"));await expect(admin.getByTestId("owner-ledger-debits")).toHaveText(formatCurrencyAmount(locale,"500.25","MAD"));
    const ledgerPath=ownerLedgerPath(locale,setup.ownerId),propertyLedgerPath=ownerLedgerPath(locale,setup.ownerId,setup.propertyId);
    await ownerPage.goto(ledgerPath);await expect(ownerPage.getByTestId("owner-ledger-line")).toHaveCount(1);await expect(ownerPage.getByTestId("owner-ledger-closing")).toHaveText(formatCurrencyAmount(locale,"-500.25","MAD"));
    expect(await ownerPage.content()).not.toContain(setup.bankId);expect((await fieldPage.request.get(ledgerPath)).status()).toBe(404);
    expect((await ownerPage.request.get(ownerLedgerPath(locale,setup.unrelatedOwnerId))).status()).toBe(404);
    await ownerPage.getByTestId("owner-ledger-property").selectOption(propertyLedgerPath);await ownerPage.getByTestId("owner-ledger-apply").click();await expect.poll(()=>new URL(ownerPage.url()).pathname).toBe(propertyLedgerPath);
    await expect(ownerPage.getByTestId("owner-ledger-filters")).toHaveAttribute("aria-busy","false");
    await expect(ownerPage.getByTestId("owner-ledger-property")).toHaveValue(propertyLedgerPath);await expect(ownerPage.getByTestId("owner-ledger-closing")).toHaveText(formatCurrencyAmount(locale,"-500.25","MAD"));
    expect((await new AxeBuilder({page:ownerPage}).analyze()).violations).toEqual([]);await ownerPage.evaluate(()=>document.documentElement.style.fontSize="200%");
    expect(await ownerPage.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);await ownerPage.evaluate(()=>document.documentElement.style.setProperty("--font-sans","monospace"));
    await ownerPage.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));expect(await ownerPage.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await ownerPage.evaluate(()=>document.documentElement.style.removeProperty("--font-sans"));await ownerPage.screenshot({path:info.outputPath(`native-owner-ledger-${locale}.png`),fullPage:true});await ownerPage.evaluate(()=>document.documentElement.style.fontSize="");
    await expect(ownerPage.locator("html")).toHaveAttribute("dir",locale==="ar"?"rtl":"ltr");await admin.goto(expenseReturnUrl);
    await admin.locator("main").evaluate(element=>{(element as HTMLElement).style.fontSize="200%";});
    expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await admin.evaluate(()=>document.documentElement.style.setProperty("--font-sans","monospace"));
    await admin.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
    expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await admin.evaluate(()=>document.documentElement.style.removeProperty("--font-sans"));
    await admin.screenshot({path:info.outputPath(`native-expense-reversal-zoom-${locale}.png`),fullPage:true});
    await admin.locator("main").evaluate(element=>{(element as HTMLElement).style.fontSize="";});
    await admin.getByTestId("expense-void-reason").fill("Dedicated reversal retains original payment history");
    const voidRequest=admin.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&
      new URL(request.url()).pathname.endsWith(`/expenses/${expenseId}`)&&Boolean(request.postData()?.includes(expenseId)));
    await admin.getByTestId("expense-void").click();const reversal=await voidRequest;
    await expect(admin.getByTestId("expense-void-form")).toHaveCount(0);await expect(admin.getByTestId("expense-post-form")).toHaveCount(0);
    const voidHeaders={"content-type":reversal.headers()["content-type"],"next-action":reversal.headers()["next-action"],accept:"text/x-component",origin};
    const deniedVoid=await ownerPage.request.post(reversal.url(),{data:reversal.postDataBuffer()!,headers:voidHeaders});expect(await deniedVoid.text()).toContain('"code":"forbidden"');
    const repeatedVoid=await admin.request.post(reversal.url(),{data:reversal.postDataBuffer()!,headers:voidHeaders});expect(await repeatedVoid.text()).toContain('"idempotent":true');
    await ownerPage.reload();await expect(ownerPage.getByTestId("owner-ledger-closing")).toHaveText(formatCurrencyAmount(locale,"0.00","MAD"));await expect(ownerPage.getByTestId("owner-ledger-line")).toHaveCount(2);
    await withTenant(f.db,f.organizationId,async tx=>{
      const expense=await tx.expense.findUniqueOrThrow({where:{id:expenseId}});expect(expense.state).toBe("VOIDED");
      const original=await tx.financialTransaction.findUniqueOrThrow({where:{id:expense.transactionId!},include:{postings:true,reversedByTransactions:{include:{postings:true}}}});
      expect(original.postings).toHaveLength(2);expect(original.reversedByTransactions).toHaveLength(1);
      expect(original.reversedByTransactions[0].postings.map(line=>({account:line.ledgerAccountId,side:line.side,amount:line.amount.toString(),bucket:line.bucket,dimensions:line.dimensions}))).toEqual(expect.arrayContaining(
        original.postings.map(line=>({account:line.ledgerAccountId,side:line.side==="DEBIT"?"CREDIT":"DEBIT",amount:line.amount.toString(),bucket:line.bucket,dimensions:line.dimensions}))));
      expect(await tx.auditLog.count({where:{resourceId:expenseId,action:"expense.voided"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:expenseId,action:"expense.voided",actorId:setup.ownerAccountId}})).toBe(0);
    });
    // The agreement may waive the owner decision, but never its durable notice or audit flag.
    await withTenant(f.db,f.organizationId,async tx=>{
      await new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"finance.approval_thresholds",scopeType:"property",scopeId:setup.propertyId,
        effectiveFrom:new Date("2020-01-01"),reason:"Dedicated configured emergency exception",value:{
          thresholds:[{key:"native_expense",amount:"100",currency:"MAD",requires_approval_from:["owner"],emergency_bypass_owner:true}],
          routing:{owner:{roles:[setup.ownerRoleId],people:[],assigned:false,channels:["in_app"]}}
        }});
      await tx.notificationPreference.upsert({where:{organizationId_userAccountId:{organizationId:f.organizationId,userAccountId:setup.ownerAccountId}},
        create:{organizationId:f.organizationId,userAccountId:setup.ownerAccountId,inAppEnabled:false,inAppOperations:false},update:{inAppEnabled:false,inAppOperations:false}});
    });
    await admin.goto(`/${locale}/app/properties/${setup.propertyId}/expenses/new`);
    const emergencyForm=admin.getByTestId("expense-draft-form"); await emergencyForm.getByTestId("expense-amount").fill("500.25");
    await emergencyForm.getByTestId("expense-category").fill("maintenance"); await emergencyForm.getByTestId("expense-purpose").fill(`Dedicated emergency ${suffix}`);
    await selectPaymentAccount(emergencyForm,"expense-funding-account",setup.bankId); await emergencyForm.getByTestId("expense-occurred-on").fill("2026-10-26");
    await emergencyForm.getByTestId("expense-emergency").check(); await emergencyForm.getByTestId("expense-reason").fill("Dedicated emergency entry");
    await emergencyForm.getByTestId("expense-create").click(); await expect(admin.getByTestId("expense-detail-page")).toBeVisible();
    const emergencyId=new URL(admin.url()).pathname.split("/").at(-1)!;
    await admin.getByTestId("expense-submit-reason").fill("Dedicated emergency agreement exception"); await admin.getByTestId("expense-submit").click();
    await expect(admin.getByTestId("expense-emergency-notice")).toBeVisible(); await expect(admin.getByTestId("expense-approval-link")).toHaveCount(0);
    await ownerPage.reload(); await ownerPage.getByTestId("notification-bell").click();
    const emergencyNotice=ownerPage.getByTestId("notification-item").filter({hasText:locale==="en"?"Emergency expense approval exception":locale==="fr"?"Exception de validation pour une dépense urgente":"استثناء موافقة لمصروف طارئ"});
    await expect(emergencyNotice).toHaveCount(1); await emergencyNotice.getByRole("button").first().click();
    await expect(ownerPage).toHaveURL(new RegExp(`/${locale}/app/expenses/${emergencyId}$`,"u"));
    await expect(ownerPage.getByTestId("expense-emergency-notice")).toBeVisible(); await expect(ownerPage.getByTestId("expense-submit-form")).toHaveCount(0);
    await expect(ownerPage.getByTestId("expense-total")).toHaveText(formatCurrencyAmount(locale,"500.25","MAD"));
    expect((await new AxeBuilder({page:ownerPage}).analyze()).violations).toEqual([]);
    await withTenant(f.db,f.organizationId,async tx=>{
      const expense=await tx.expense.findUniqueOrThrow({where:{id:emergencyId}}); expect(expense.state).toBe("APPROVED"); expect(expense.transactionId).toBeNull();
      expect(await tx.approvalRequest.count({where:{expenseId:emergencyId}})).toBe(0);
      expect(await tx.notification.count({where:{kind:"expense_emergency",targetId:emergencyId,recipientId:setup.ownerAccountId}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:emergencyId,action:"expense.emergency_owner_notified"}})).toBe(1);
      expect(await tx.auditLog.count({where:{resourceId:emergencyId,actorId:setup.ownerAccountId}})).toBe(0);
    });
    const customRule=await withTenant(f.db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:setup.propertyId,
      effectiveFrom:new Date("2020-01-02"),reason:"Dedicated configured three-party allocation",value:{default_treatment:"OWNER_PAID",categories:{maintenance:{treatment:"CUSTOM",owner_share_bps:2500,alvillas_share_bps:2500,guest_share_bps:5000}}}}));
    await admin.goto(`/${locale}/app/properties/${setup.propertyId}/expenses/new`);
    const customForm=admin.getByTestId("expense-draft-form");await customForm.getByTestId("expense-amount").fill("100.11");await customForm.getByTestId("expense-category").fill("maintenance");
    await customForm.getByTestId("expense-purpose").fill(`Dedicated custom expense ${suffix}`);await selectPaymentAccount(customForm,"expense-funding-account",setup.bankId);
    await customForm.getByTestId("expense-occurred-on").fill("2026-10-26");await customForm.getByTestId("expense-reason").fill("Dedicated custom allocation entry");
    await customForm.getByTestId("expense-create").click();await expect(admin.getByTestId("expense-detail-page")).toBeVisible();
    const customId=new URL(admin.url()).pathname.split("/").at(-1)!;
    await admin.getByTestId("expense-edit").click();await expect(admin.getByTestId("expense-edit-page")).toBeVisible();
    await expect(admin.getByTestId("expense-amount")).toHaveValue("100.11");await expect(admin.getByTestId("expense-funding-account")).toHaveValue(setup.bankId);
    await admin.getByTestId("expense-amount").fill("100.01");await admin.getByTestId("expense-reason").fill("Dedicated audited correction before approval");
    expect((await new AxeBuilder({page:admin}).analyze()).violations).toEqual([]);
    const editedRequest=admin.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&new URL(request.url()).pathname.endsWith(`/expenses/${customId}/edit`)&&Boolean(request.postData()?.includes(customId)));
    await admin.getByTestId("expense-create").click();const edited=await editedRequest;
    await expect(admin.getByTestId("expense-detail-page")).toBeVisible();await expect(admin.getByTestId("expense-total")).toHaveText(formatCurrencyAmount(locale,"100.01","MAD"));
    expect((await fieldPage.request.get(`/${locale}/app/expenses/${customId}/edit`)).status()).toBe(404);
    const deniedEdit=await fieldPage.request.post(edited.url(),{data:edited.postDataBuffer()!,headers:{"content-type":edited.headers()["content-type"],"next-action":edited.headers()["next-action"],accept:"text/x-component",origin}});
    expect(await deniedEdit.text()).toContain('"code":"forbidden"');
    await admin.getByTestId("expense-submit-reason").fill("Dedicated custom allocation owner review");await admin.getByTestId("expense-submit").click();
    await expect(admin.getByTestId("expense-approval-link")).toBeVisible();await ownerPage.goto((await admin.getByTestId("expense-approval-link").getAttribute("href"))!);
    await expect(ownerPage.getByTestId("approval-approve")).toBeEnabled();await ownerPage.getByTestId("approval-reason").fill("Owner accepts the configured custom expense");await ownerPage.getByTestId("approval-approve").click();
    await expect(ownerPage.getByTestId("approval-approve")).toHaveCount(0);await admin.reload();await expect(admin.getByTestId("expense-post-form")).toBeVisible();
    await admin.getByTestId("expense-post-reason").fill("Dedicated approved custom allocation payment");await admin.getByTestId("expense-post").click();await expect(admin.getByTestId("expense-void-form")).toBeVisible();
    await withTenant(f.db,f.organizationId,async tx=>{
      const expense=await tx.expense.findUniqueOrThrow({where:{id:customId}});expect(expense.state).toBe("POSTED");
      const lines=await tx.posting.findMany({where:{transactionId:expense.transactionId!}});expect(lines).toHaveLength(4);
      expect(Object.fromEntries(lines.filter(line=>line.side==="DEBIT").map(line=>[line.bucket,line.amount.toString()]))).toEqual({OWNER_EXPENSE:"25",ALVILLAS_EXPENSE:"25",GUEST_EXPENSE:"50.01"});
      expect(lines.find(line=>line.side==="CREDIT")?.amount.toString()).toBe("100.01");
      expect((await tx.expenseSubmission.findFirstOrThrow({where:{expenseId:customId}})).snapshot).toMatchObject({policies:[{allocationRule:{configRuleId:customRule.id,version:customRule.version}}]});
      expect(await tx.auditLog.count({where:{resourceId:customId,action:"expense.updated"}})).toBe(1);
    });
    const correctionSource=await withTenant(f.db,f.organizationId,async tx=>{
      const expense=await tx.expense.findUniqueOrThrow({where:{id:customId}});
      return{expense,journal:await tx.financialTransaction.findUniqueOrThrow({where:{id:expense.transactionId!},include:{postings:{orderBy:{id:"asc"}}}}),
        submission:await tx.expenseSubmission.findUniqueOrThrow({where:{organizationId_expenseId:{organizationId:f.organizationId,expenseId:customId}}})};
    });
    await expect(admin.getByTestId("expense-correction-form")).toBeVisible();
    await admin.getByTestId("expense-corrected-amount").fill("180,00");await admin.getByTestId("expense-correction-reason").fill("Dedicated corrected supplier invoice amount");
    const prepareCapture=admin.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&Boolean(request.postData()?.includes(customId)));
    await admin.getByTestId("expense-correction-create").click();const prepareRequest=await prepareCapture;
    await admin.waitForURL(url=>url.pathname.endsWith("/expenses/"+url.pathname.split("/").at(-1))&&!url.pathname.endsWith("/"+customId));
    await expect(admin.getByTestId("expense-correction-source")).toBeVisible();const correctedId=new URL(admin.url()).pathname.split("/").at(-1)!;
    const prepareHeaders={"content-type":prepareRequest.headers()["content-type"],"next-action":prepareRequest.headers()["next-action"],accept:"text/x-component",origin};
    for(const response of await Promise.all(Array.from({length:4},()=>admin.request.post(prepareRequest.url(),{data:prepareRequest.postDataBuffer()!,headers:prepareHeaders}))))expect(await response.text()).toContain('"idempotent":true');
    for(const restricted of[fieldPage,ownerPage])expect(await(await restricted.request.post(prepareRequest.url(),{data:prepareRequest.postDataBuffer()!,headers:prepareHeaders})).text()).toContain('"code":"forbidden"');
    await admin.getByTestId("expense-edit").click();await expect(admin.getByTestId("expense-currency")).toBeDisabled();await expect(admin.getByTestId("expense-funding-account")).toBeDisabled();
    await expect(admin.getByTestId("expense-occurred-on")).toHaveAttribute("readonly","");await expect(admin.getByTestId("expense-category")).toHaveAttribute("readonly","");
    await admin.getByTestId("expense-amount").fill("200,00");await admin.getByTestId("expense-reason").fill("Dedicated corrected total before independent approval");
    expect((await new AxeBuilder({page:admin}).analyze()).violations).toEqual([]);await admin.getByTestId("expense-create").click();
    await expect(admin.getByTestId("expense-total")).toHaveText(formatCurrencyAmount(locale,"200.00","MAD"));
    await withTenant(f.db,f.organizationId,async tx=>{
      expect((await tx.expense.findUniqueOrThrow({where:{id:customId}})).state).toBe("POSTED");
      expect(await tx.financialTransaction.count({where:{reversesTransactionId:correctionSource.journal.id}})).toBe(0);
      const config=new ConfigRuleRepository(tx,f.organizationId);
      await config.createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:setup.propertyId,effectiveFrom:new Date("2020-01-03"),
        reason:"Later allocation does not replace the corrected invoice agreement",value:{default_treatment:"ALVILLAS_PAID"}});
      await config.createVersion({key:"finance.approval_thresholds",scopeType:"property",scopeId:setup.propertyId,effectiveFrom:new Date("2020-01-03"),
        reason:"Later waiver does not remove original corrected invoice approval",value:{thresholds:[]}});
    });
    await admin.getByTestId("expense-submit-reason").fill("Dedicated separate corrected invoice approval");await admin.getByTestId("expense-submit").click();
    await expect(admin.getByTestId("expense-approval-link")).toBeVisible();await expect(admin.getByTestId("expense-post-form")).toHaveCount(0);
    await ownerPage.goto((await admin.getByTestId("expense-approval-link").getAttribute("href"))!);await expect(ownerPage.getByTestId("approval-approve")).toBeEnabled();
    await expect(ownerPage.getByTestId("approval-financial-summary")).toContainText(formatCurrencyAmount(locale,"200.00","MAD"));
    await ownerPage.getByTestId("approval-reason").fill("Owner approves the revised invoice independently");await ownerPage.getByTestId("approval-approve").click();
    await expect(ownerPage.getByTestId("approval-approve")).toHaveCount(0);await admin.reload();await expect(admin.getByTestId("expense-current-period")).not.toBeChecked();
    await expect(admin.getByTestId("expense-current-period")).toHaveAttribute("required","");await admin.getByTestId("expense-current-period").check();
    await admin.getByTestId("expense-post-reason").fill("Dedicated approved atomic invoice correction");
    const correctionCapture=admin.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&Boolean(request.postData()?.includes(correctedId)));
    await admin.getByTestId("expense-post").click();const correctionRequest=await correctionCapture;await expect(admin.getByTestId("expense-post-form")).toHaveCount(0);
    const correctionHeaders={"content-type":correctionRequest.headers()["content-type"],"next-action":correctionRequest.headers()["next-action"],accept:"text/x-component",origin};
    for(const response of await Promise.all(Array.from({length:4},()=>admin.request.post(correctionRequest.url(),{data:correctionRequest.postDataBuffer()!,headers:correctionHeaders}))))expect(await response.text()).toContain('"idempotent":true');
    for(const restricted of[fieldPage,ownerPage])expect(await(await restricted.request.post(correctionRequest.url(),{data:correctionRequest.postDataBuffer()!,headers:correctionHeaders})).text()).toContain('"code":"forbidden"');
    expect((await fieldPage.request.get(`/${locale}/app/expenses/${correctedId}`)).status()).toBe(404);
    await withTenant(f.db,f.organizationId,async tx=>{
      const original=await tx.expense.findUniqueOrThrow({where:{id:customId}}),corrected=await tx.expense.findUniqueOrThrow({where:{id:correctedId}});
      expect(original).toMatchObject({state:"VOIDED",amount:correctionSource.expense.amount,transactionId:correctionSource.journal.id});
      expect(corrected).toMatchObject({state:"POSTED",correctsExpenseId:customId,correctsExpenseVersion:correctionSource.expense.version,emergency:false});
      expect(await tx.expense.count({where:{correctsExpenseId:customId}})).toBe(1);
      expect(await tx.financialTransaction.findUniqueOrThrow({where:{id:correctionSource.journal.id},include:{postings:{orderBy:{id:"asc"}}}})).toEqual(correctionSource.journal);
      expect(await tx.expenseSubmission.findUniqueOrThrow({where:{id:correctionSource.submission.id}})).toEqual(correctionSource.submission);
      const reverse=await tx.financialTransaction.findMany({where:{reversesTransactionId:original.transactionId!},include:{postings:true}});expect(reverse).toHaveLength(1);
      expect(reverse[0].postings.map(line=>({account:line.ledgerAccountId,side:line.side,amount:line.amount.toString(),bucket:line.bucket,dimensions:line.dimensions}))).toEqual(expect.arrayContaining(
        correctionSource.journal.postings.map(line=>({account:line.ledgerAccountId,side:line.side==="DEBIT"?"CREDIT":"DEBIT",amount:line.amount.toString(),bucket:line.bucket,dimensions:line.dimensions}))));
      const lines=await tx.posting.findMany({where:{transactionId:corrected.transactionId!}});expect(lines).toHaveLength(4);
      expect(Object.fromEntries(lines.filter(line=>line.side==="DEBIT").map(line=>[line.bucket,line.amount.toString()]))).toEqual({OWNER_EXPENSE:"50",ALVILLAS_EXPENSE:"50",GUEST_EXPENSE:"100"});
      expect(lines.find(line=>line.side==="CREDIT")?.amount.toString()).toBe("200");
      expect((await tx.expenseSubmission.findUniqueOrThrow({where:{organizationId_expenseId:{organizationId:f.organizationId,expenseId:correctedId}}})).snapshot).toMatchObject({policies:[{allocationRule:{configRuleId:customRule.id,version:customRule.version}}]});
      expect(await tx.auditLog.count({where:{action:"finance.expense.correction_posted",resourceId:corrected.transactionId!}})).toBe(1);
    });
    await expect(admin.locator("html")).toHaveAttribute("dir",locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await admin.locator("main").evaluate(element => { (element as HTMLElement).style.fontSize="200%"; });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await admin.screenshot({ path: info.outputPath(`native-expense-${locale}.png`), fullPage: true });
    // Group the real payment and exact reversal produced by the native workflow.
    const groupSource = await withTenant(f.db, f.organizationId, async tx => {
      const expense = await tx.expense.findUniqueOrThrow({ where: { id: expenseId } });
      const original = await tx.financialTransaction.findUniqueOrThrow({ where: { id: expense.transactionId! }, include: { reversedByTransactions: true } });
      const ids = [original.id, original.reversedByTransactions[0].id];
      const headers = await tx.financialTransaction.findMany({ where: { id: { in: ids } }, orderBy: { id: "asc" } });
      const postings = await tx.posting.findMany({ where: { transactionId: { in: ids } }, orderBy: { id: "asc" } });
      return { ids, headers, postings };
    });
    await admin.goto(`/${locale}/app`); await admin.getByTestId("transaction-groups-link").click();
    await expect(admin.getByTestId("transaction-groups-page")).toBeVisible();
    const groupName = `Dedicated related expense ${suffix} ${"B".repeat(120)}`.slice(0, 120);
    await admin.getByTestId("transaction-group-name").fill(groupName);
    await admin.getByTestId("transaction-group-reason").fill("Dedicated native payment and reversal grouping");
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    const groupRequest = admin.waitForRequest(value => value.method() === "POST" && Boolean(value.headers()["next-action"]) && Boolean(value.postData()?.includes(groupName)));
    await admin.getByTestId("transaction-group-create").click(); const groupCreated = await groupRequest;
    await expect(admin.getByTestId("transaction-group-detail")).toBeVisible();
    const groupId = new URL(admin.url()).pathname.split("/").at(-1)!;
    const actionRequest = (value: typeof groupCreated) => ({ data: value.postDataBuffer()!, headers: {
      "content-type": value.headers()["content-type"], "next-action": value.headers()["next-action"], accept: "text/x-component", origin } });
    for (const response of await Promise.all(Array.from({ length: 4 }, () => admin.request.post(groupCreated.url(), actionRequest(groupCreated))))) expect(await response.text()).toContain('"ok":true');
    for (const restricted of [fieldPage, ownerPage]) {
      const response = await restricted.request.get(`/${locale}/app/finance/groups/${groupId}`);
      expect(response.status()).toBe(404); expect(await response.text()).not.toContain(groupName);
      expect(await (await restricted.request.post(groupCreated.url(), actionRequest(groupCreated))).text()).toContain('"code":"forbidden"');
    }
    const attach = async (source: typeof groupSource.headers[number]) => {
      await admin.getByTestId("transaction-group-candidate-search").fill(source.reference);
      await admin.getByTestId("transaction-group-candidate-search-form").locator('button[type="submit"]').click();
      await admin.getByTestId("transaction-group-candidate").selectOption(source.id);
      const form = admin.getByTestId("transaction-group-attach-form");
      await form.getByTestId("transaction-group-membership-reason").fill("Dedicated native related transaction association");
      const captured = admin.waitForRequest(value => value.method() === "POST" && Boolean(value.headers()["next-action"]) && Boolean(value.postData()?.includes(source.id)));
      await form.getByTestId("transaction-group-attach").click(); const mutation = await captured;
      await expect(admin.getByTestId("transaction-group-member").filter({ has: admin.getByRole("heading", { name: source.reference, exact: true }) })).toHaveCount(1);
      return mutation;
    };
    const firstGroupAttachment = await attach(groupSource.headers[0]); await attach(groupSource.headers[1]);
    for (const response of await Promise.all(Array.from({ length: 4 }, () => admin.request.post(firstGroupAttachment.url(), actionRequest(firstGroupAttachment))))) expect(await response.text()).toContain('"ok":true');
    expect(await (await fieldPage.request.post(firstGroupAttachment.url(), actionRequest(firstGroupAttachment))).text()).toContain('"code":"forbidden"');
    await expect(admin.getByTestId("transaction-group-member")).toHaveCount(2);
    await expect(admin.getByTestId("transaction-group-history")).toHaveCount(2);
    await expect(admin.getByTestId("transaction-group-movement")).toHaveCount(2);
    for (const movement of await admin.getByTestId("transaction-group-movement").all()) await expect(movement.locator("strong")).toHaveText(formatCurrencyAmount(locale, "0.00", "MAD"));
    const member = admin.getByTestId("transaction-group-member").filter({ has: admin.getByRole("heading", { name: groupSource.headers[0].reference, exact: true }) });
    await member.locator("details").last().locator("summary").click();
    await member.getByTestId("transaction-group-membership-reason").fill("Dedicated grouping correction preserves journal facts");
    await member.getByTestId("transaction-group-detach").click(); await expect(admin.getByTestId("transaction-group-member")).toHaveCount(1);
    await expect(admin.getByTestId("transaction-group-history")).toHaveCount(3);
    expect(await (await admin.request.post(firstGroupAttachment.url(), actionRequest(firstGroupAttachment))).text()).toContain('"ok":true');
    await admin.reload(); await expect(admin.getByTestId("transaction-group-member")).toHaveCount(1);
    await attach(groupSource.headers[0]); await expect(admin.getByTestId("transaction-group-history")).toHaveCount(4);
    await withTenant(f.db, f.organizationId, async tx => {
      expect(await tx.financialTransaction.findMany({ where: { id: { in: groupSource.ids } }, orderBy: { id: "asc" } })).toEqual(groupSource.headers);
      expect(await tx.posting.findMany({ where: { transactionId: { in: groupSource.ids } }, orderBy: { id: "asc" } })).toEqual(groupSource.postings);
      expect(await tx.transactionGroup.count({ where: { id: groupId } })).toBe(1);
      expect(await tx.transactionGroupEntry.count({ where: { groupId } })).toBe(4);
      expect(await tx.auditLog.count({ where: { resourceType: "transaction_group", resourceId: groupId } })).toBe(5);
      expect(await tx.auditLog.count({ where: { resourceType: "transaction_group", resourceId: groupId, actorId: { in: [fieldUser.id, setup.ownerAccountId] } } })).toBe(0);
    });
    await expect(admin.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await admin.locator("main").evaluate(element => { (element as HTMLElement).style.fontSize = "200%"; });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await admin.screenshot({ path: info.outputPath(`native-transaction-group-${locale}.png`), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await Promise.all([ownerContext.close(),fieldContext.close()]); await f.db.$disconnect(); }
});
