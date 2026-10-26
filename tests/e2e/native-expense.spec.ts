import { randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { formatCurrencyAmount } from "@/i18n/format";
import { openFieldFixture } from "./support/field-fixture";
import { ensureE2EAdmin, e2eEmail, completeE2EAdminMfa, waitForE2EAdminLoginWindow } from "./support/auth";

test.use({ serviceWorkers: "allow", actionTimeout: 30000, navigationTimeout: 60000 });
for (const locale of ["en", "fr", "ar"] as const) test(`Native expense submission and scoped owner approval in ${locale}`, async ({ page: admin, browser }, info) => {
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
      return { propertyId: task.propertyId, bankId: bank.id, ownerAccountId: account.id, ownerRoleId: role.id };
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
    await form.getByTestId("expense-funding-account").selectOption(setup.bankId); await form.getByTestId("expense-occurred-on").fill("2026-10-26");
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
    });
    await ownerPage.reload();await expect(ownerPage.getByTestId("expense-void-form")).toHaveCount(0);
    await expect(admin.getByTestId("expense-void-form")).toBeVisible();
    await admin.locator("main").evaluate(element=>{(element as HTMLElement).style.fontSize="200%";});
    expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
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
    await emergencyForm.getByTestId("expense-funding-account").selectOption(setup.bankId); await emergencyForm.getByTestId("expense-occurred-on").fill("2026-10-26");
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
    await expect(admin.locator("html")).toHaveAttribute("dir",locale === "ar" ? "rtl" : "ltr");
    expect((await new AxeBuilder({ page: admin }).analyze()).violations).toEqual([]);
    await admin.locator("main").evaluate(element => { (element as HTMLElement).style.fontSize="200%"; });
    expect(await admin.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await admin.screenshot({ path: info.outputPath(`native-expense-${locale}.png`), fullPage: true }); expect(errors).toEqual([]);
  } finally { await Promise.all([ownerContext.close(),fieldContext.close()]); await f.db.$disconnect(); }
});
