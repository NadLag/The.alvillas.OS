import { randomInt,randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect,test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { fieldWalletSnapshotSchema } from "@/modules/identity/domain/field-wallet";
import { Money } from "@/platform/money/money";
import en from "../../messages/en.json" with {type:"json"};
import { openFieldFixture } from "./support/field-fixture";
import { storedFieldData } from "./support/field-storage";

test.use({serviceWorkers:"allow",timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of ["en","fr","ar"] as const)test(`Native advances, approved expenses and reasoned returns produce the private employee wallet in ${locale}`,async({page:admin,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(420000);
  const f=await openFieldFixture(admin,info,"en"),origin=new URL(admin.url()).origin,suffix=randomUUID().slice(0,8);
  const context=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]},viewport:{width:info.project.name==="field-mobile"?360:1440,height:900}}),page=await context.newPage();
  const phone=`+21266${randomInt(1_000_000,10_000_000)}`,pin="368247",roleKey=`e2e_native_wallet_${suffix}`,bankName=`Native wallet funding bank ${suffix}`,advancePurpose=`Native employee working advance ${suffix}`;
  let releaseWorkPull:()=>void=()=>undefined;
  try{
    await admin.goto("/en/app/identity");await admin.getByTestId("invite-display-name").fill(`Dedicated native wallet employee ${suffix}`);
    await admin.getByTestId("invite-phone").fill(phone);await admin.getByTestId("invite-role").selectOption("field_staff");
    await admin.getByTestId("invite-scope-type").selectOption("job");await admin.getByTestId("invite-scope-id").fill(f.taskId);await admin.getByTestId("invite-preferred-locale").selectOption(locale);await admin.getByTestId("invite-submit").click();
    const invitation=(await admin.getByTestId("invitation-code").innerText()).split(":").at(-1)?.trim();expect(invitation).toBeTruthy();
    await page.goto(`/${locale}/activate/${invitation}`);await page.getByTestId("activation-phone").fill(phone);await page.getByTestId("activation-pin").fill(pin);await page.getByTestId("activation-submit").click();await expect(page).toHaveURL(new RegExp(`/${locale}/login$`,"u"));
    await page.goto(`/${locale}/login?surface=field`);await page.getByTestId("login-phone").fill(phone);await page.getByTestId("login-pin").fill(pin);await page.getByTestId("login-submit").click();await expect(page).toHaveURL(new RegExp(`/${locale}/app/field$`,"u"));
    const user=z.object({user:z.object({id:z.uuid(),personId:z.uuid(),organizationId:z.uuid()})}).parse(await(await page.request.get("/api/auth/session")).json()).user;expect(user.organizationId).toBe(f.organizationId);
    await expect.poll(async()=>z.array(z.object({cursor:z.string().optional()})).parse(await storedFieldData(page,"cacheState")).some(row=>Boolean(row.cursor))).toBe(true);
    await admin.goto(`/en/app/team/${user.personId}`);await admin.getByText(en.Team.linkWallet,{exact:true}).click();
    const linkForm=admin.getByTestId("team-wallet-form"),walletName=`Native employee wallet ${suffix}`;await linkForm.locator('[name="ledgerAccountId"]').selectOption("");await linkForm.locator('[name="accountName"]').fill(walletName);await linkForm.locator('[name="reason"]').fill("Dedicated native wallet movement acceptance");
    const linked=admin.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname===`/en/app/team/${user.personId}`&&Boolean(response.request().postData()?.includes(walletName)),{timeout:30000});
    await linkForm.locator('button[type="submit"]').click();expect((await linked).ok()).toBe(true);await expect(linkForm).toHaveCount(0);
    const link=await withTenant(f.db,f.organizationId,tx=>tx.teamWallet.findFirstOrThrow({where:{personId:user.personId}}));
    await admin.goto("/en/app/identity");const roleForm=admin.getByTestId("custom-role-create-form");await roleForm.getByTestId("custom-role-name").fill(`Native own wallet ${suffix}`);await roleForm.getByTestId("custom-role-key").fill(roleKey);await roleForm.getByTestId("custom-role-description").fill("Explicit own-wallet read without general financial access");await roleForm.locator('input[name="permissionKeys"][value="wallet:view"]').check();await roleForm.getByTestId("custom-role-submit").click();
    await expect(roleForm.getByRole("status")).toHaveText("Custom role created.",{timeout:30000});
    const role=await withTenant(f.db,f.organizationId,tx=>tx.role.findFirstOrThrow({where:{key:roleKey}})),assignment=admin.locator("form.role-assignment-form");
    await assignment.getByTestId("assignment-account").selectOption(user.id);await assignment.getByTestId("assignment-role").selectOption(role.id);await assignment.getByTestId("assignment-scope-type").selectOption("wallet");await assignment.getByTestId("assignment-scope-id").fill(link.id);await assignment.locator('[name="validFrom"]').fill("2020-01-01");await assignment.getByTestId("assignment-assigned-to-me").check();await assignment.getByTestId("assignment-submit").click();
    await expect.poll(()=>withTenant(f.db,f.organizationId,tx=>tx.roleAssignment.count({where:{userAccountId:user.id,roleId:role.id,scopeType:"wallet",scopeId:link.id}}))).toBe(1);
    const propertyId=await withTenant(f.db,f.organizationId,async tx=>{
      const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),owner=await tx.owner.create({data:{organizationId:f.organizationId,displayName:`Dedicated native wallet owner ${suffix}`}});
      await tx.propertyOwner.create({data:{organizationId:f.organizationId,propertyId:task.propertyId,ownerId:owner.id}});
      const config=new ConfigRuleRepository(tx,f.organizationId);await config.createVersion({key:"finance.expense_treatment",scopeType:"property",scopeId:task.propertyId,effectiveFrom:new Date("2020-01-01"),reason:"Dedicated explicit wallet expense treatment",value:{default_treatment:"OWNER_PAID"}});
      await config.createVersion({key:"finance.approval_thresholds",scopeType:"property",scopeId:task.propertyId,effectiveFrom:new Date("2020-01-01"),reason:"Dedicated explicit policy without approval stages",value:{thresholds:[]}});return task.propertyId;
    });
    await admin.goto(`/${locale}/app/finance/accounts`);await admin.getByTestId("payment-account-name").fill(bankName);await admin.getByTestId("payment-account-kind").selectOption("BANK");await admin.getByTestId("payment-account-reason").fill("Dedicated native wallet funding location");await admin.getByTestId("payment-account-create").click();await expect(admin.getByTestId("payment-account-saved")).toBeVisible();
    const bank=await withTenant(f.db,f.organizationId,tx=>tx.ledgerAccount.findFirstOrThrow({where:{name:bankName}}));
    await admin.getByTestId("financial-transfers-entry").click();await expect(admin.getByTestId("financial-transfer-page")).toBeVisible();
    // Selected authorized accounts remain available beyond the first picker page.
    await admin.goto(`/${locale}/app/finance/transfers?from=${bank.id}&to=${link.ledgerAccountId}`);
    const transfer=admin.getByTestId("financial-transfer-form");await expect(transfer.getByTestId("transfer-submit")).toBeEnabled();await transfer.getByTestId("transfer-kind").selectOption("ADVANCE");await transfer.getByTestId("transfer-amount").fill("1500");await transfer.getByTestId("transfer-currency").selectOption("MAD");await transfer.getByTestId("transfer-purpose").fill(advancePurpose);await transfer.getByTestId("transfer-reason").fill("Dedicated authorized native employee advance");
    expect((await new AxeBuilder({page:admin}).analyze()).violations).toEqual([]);
    const captured=admin.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&new URL(request.url()).pathname.endsWith("/finance/transfers")&&Boolean(request.postData()?.includes(advancePurpose)));
    await transfer.getByTestId("transfer-submit").click();const request=await captured;await expect(admin.getByTestId("transfer-saved")).toBeVisible();
    const headers={"content-type":request.headers()["content-type"],"next-action":request.headers()["next-action"],accept:"text/x-component",origin};
    const replay=await Promise.all(Array.from({length:4},()=>admin.request.post(request.url(),{data:request.postDataBuffer()!,headers})));for(const response of replay)expect(await response.text()).toContain('"ok":true');
    const denied=await page.request.post(request.url(),{data:request.postDataBuffer()!,headers});expect(await denied.text()).toContain('"code":"forbidden"');expect((await page.request.get(`/${locale}/app/finance/transfers`)).status()).toBe(404);
    const expenses:string[]=[];
    for(const [amount,category] of [["850","groceries"],["200","supplies"]] as const){
      await admin.goto(`/${locale}/app/properties/${propertyId}/expenses/new?fundingAccountId=${link.ledgerAccountId}`);const draft=admin.getByTestId("expense-draft-form");await draft.getByTestId("expense-amount").fill(amount);await draft.getByTestId("expense-category").fill(category);await draft.getByTestId("expense-purpose").fill(`Native wallet ${category} ${suffix}`);await draft.getByTestId("expense-funding-account").selectOption(link.ledgerAccountId);await draft.getByTestId("expense-reason").fill("Dedicated native wallet expense entry");await draft.getByTestId("expense-create").click();
      await expect(admin.getByTestId("expense-detail-page")).toBeVisible();const id=new URL(admin.url()).pathname.split("/").at(-1)!;expenses.push(id);
      await admin.getByTestId("expense-submit-reason").fill("Dedicated configured wallet approval");
      const submitted=admin.waitForResponse(response=>response.request().method()==="POST"&&Boolean(response.request().headers()["next-action"])&&
        new URL(response.url()).pathname.endsWith(`/expenses/${id}`)&&Boolean(response.request().postData()?.includes(id)));
      await admin.getByTestId("expense-submit").click();expect((await submitted).ok()).toBe(true);await expect(admin.getByTestId("expense-post-form")).toBeVisible();
      await admin.getByTestId("expense-post-reason").fill("Dedicated approved native wallet payment");await admin.getByTestId("expense-post").click();await expect(admin.getByTestId("expense-void-form")).toBeVisible();
    }
    const returnPurpose=`Native remaining advance return ${suffix}`;await admin.goto(`/${locale}/app/finance/transfers?from=${link.ledgerAccountId}&to=${bank.id}`);await expect(admin.getByTestId("transfer-submit")).toBeEnabled();await admin.getByTestId("transfer-kind").selectOption("RETURN");await admin.getByTestId("transfer-amount").fill("450");await admin.getByTestId("transfer-purpose").fill(returnPurpose);await admin.getByTestId("transfer-reason").fill("Dedicated native return of remaining funds");await admin.getByTestId("transfer-submit").click();await expect(admin.getByTestId("transfer-saved")).toBeVisible();
    const returned=admin.getByTestId("transfer-row").filter({hasText:returnPurpose});await returned.getByTestId("transfer-void-form").locator('[name="reason"]').fill("Dedicated return recorded in error");await returned.getByTestId("transfer-void-form").getByRole("button").click();await expect(returned.getByTestId("transfer-void-form")).toHaveCount(0);
    await admin.evaluate(()=>document.documentElement.style.fontSize="200%");expect(await admin.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await admin.evaluate(()=>document.documentElement.style.fontSize="");expect((await new AxeBuilder({page:admin}).analyze()).violations).toEqual([]);
    const proof=await withTenant(f.db,f.organizationId,async tx=>{
      const movements=await tx.posting.findMany({where:{ledgerAccountId:link.ledgerAccountId},include:{transaction:true}});
      const advance=await tx.financialTransaction.findFirstOrThrow({where:{description:advancePurpose}});
      expect(movements).toHaveLength(5);expect(movements.reduce((total,row)=>row.side==="DEBIT"?total.add(Money.of(row.amount.toString(),row.currency)):total.subtract(Money.of(row.amount.toString(),row.currency)),Money.zero("MAD")).toJSON()).toEqual({amount:"450.00",currency:"MAD"});
      expect(await tx.auditLog.count({where:{action:"finance.transfer.posted",resourceId:advance.id}})).toBe(1);expect(await tx.expense.count({where:{id:{in:expenses},state:"POSTED"}})).toBe(2);expect(await tx.auditLog.count({where:{actorId:user.id,action:{in:["finance.transfer.posted","expense.posted"]}}})).toBe(0);return movements.map(row=>row.id);
    });
    const release=new Promise<void>(resolve=>{releaseWorkPull=resolve});let scopeResetObserved=false;
    await page.route("**/api/sync/pull?**",async route=>{const response=await route.fetch();if(response.status()===409){scopeResetObserved=true;await release}await route.fulfill({response})});
    await page.goto(`/${locale}/app/field/wallet`);await expect(page.getByTestId("field-wallet")).toBeVisible();await expect(page.getByTestId("field-wallet-movement")).toHaveCount(5);
    const response=await page.request.get("/api/field/wallet"),text=await response.text();expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toBe("private, no-store");
    const model=fieldWalletSnapshotSchema.parse(JSON.parse(text));expect(model.balances).toContainEqual({currency:"MAD",amount:"450.00"});expect(new Set(model.movements.map(row=>row.id))).toEqual(new Set(proof));expect(text).not.toContain(bank.id);expect(text).not.toContain(bankName);expect(model.compensationVisible).toBe(false);
    const states=z.array(z.object({generation:z.number(),wallet:fieldWalletSnapshotSchema.optional()}));
    await expect.poll(async()=>states.parse(await storedFieldData(page,"cacheState")).some(row=>row.wallet?.userId===user.id&&row.wallet.balances.some(balance=>balance.currency==="MAD"&&balance.amount==="450.00"))).toBe(true);
    const beforeReset=states.parse(await storedFieldData(page,"cacheState")).find(row=>row.wallet?.userId===user.id)!.generation;
    await expect.poll(()=>scopeResetObserved).toBe(true);releaseWorkPull();
    await expect.poll(async()=>states.parse(await storedFieldData(page,"cacheState")).some(row=>row.generation>beforeReset&&row.wallet?.userId===user.id&&row.wallet.balances.some(balance=>balance.currency==="MAD"&&balance.amount==="450.00"))).toBe(true);
    await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);await context.setOffline(true);await page.reload();await expect(page).toHaveURL(new RegExp(`/${locale}/offline/field\\?view=wallet$`,"u"));await expect(page.getByTestId("field-wallet-movement")).toHaveCount(5);
    expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.evaluate(()=>document.documentElement.style.fontSize="200%");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.evaluate(()=>document.documentElement.style.fontSize="");await expect(page.locator("html")).toHaveAttribute("dir",locale==="ar"?"rtl":"ltr");await page.screenshot({path:info.outputPath(`native-wallet-${locale}.png`),fullPage:true});
  }finally{releaseWorkPull();await context.setOffline(false);await page.unrouteAll({behavior:"wait"});await context.close();await f.db.$disconnect()}
});
