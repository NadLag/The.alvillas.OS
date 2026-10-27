import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { PrismaClient } from "@prisma/client";
import { expect,test,type Page } from "@playwright/test";
import { withTenant } from "@/platform/db/tenant";
import { bootstrapOrganizationId } from "@/platform/identity/bootstrap";
import { encryptSecret } from "@/platform/auth/secret-encryption";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { Money } from "@/platform/money/money";
import { ownerLedgerPath } from "@/modules/finance/domain/owner-ledger";
import { ownerPayoutWorkspacePath } from "@/modules/finance/domain/owner-payout";
import { formatCurrencyAmount } from "@/i18n/format";
import { ensureE2EAdmin,e2eEmail,completeE2EAdminMfa,waitForE2EAdminLoginWindow } from "./support/auth";

test.use({timezoneId:"America/Denver",actionTimeout:30000,navigationTimeout:60000});
for(const locale of ["en","fr","ar"] as const)test(`Native owner payout review, manual transfer, exact reversal and scoped history in ${locale}`,async({page:operator,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL is required");test.setTimeout(360000);
  if(!["localhost","127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error("Dedicated local payout acceptance is required");
  const db=new PrismaClient(),org=bootstrapOrganizationId,suffix=randomUUID().slice(0,8),password=process.env.ADMIN_PASSWORD??"correct horse battery staple";
  const operatorEmail=e2eEmail(`payout-operator-${locale}-${suffix}`,info.project.name),reviewerEmail=e2eEmail(`payout-reviewer-${locale}-${suffix}`,info.project.name);
  const origin=process.env.PLAYWRIGHT_TEST_BASE_URL??process.env.APP_URL??"http://127.0.0.1:3000";
  const reviewerContext=await browser.newContext({baseURL:origin,viewport:{width:info.project.name==="field-mobile"?360:1440,height:900},timezoneId:"America/Denver"});
  const reviewer=await reviewerContext.newPage(),errors:string[]=[];for(const page of [operator,reviewer])page.on("pageerror",error=>errors.push(error.message));
  const signIn=async(page:Page,email:string)=>{
    await page.goto(`${origin}/en/login`);await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);
    await page.getByTestId("login-submit").click();await completeE2EAdminMfa(page,email);await expect(page).toHaveURL(/\/en\/app$/u);
  };
  try{
    await ensureE2EAdmin(operatorEmail,password);await ensureE2EAdmin(reviewerEmail,password);
    await signIn(operator,operatorEmail);await signIn(reviewer,reviewerEmail);
    if(info.project.name==="field-mobile")await operator.setViewportSize({width:360,height:900});
    const source=await withTenant(db,org,async tx=>{
      await tx.currency.upsert({where:{code:"MAD"},update:{},create:{code:"MAD",name:"Dirham",minorUnit:2}});
      const author=await tx.userAccount.findFirstOrThrow({where:{organizationId:org,email:operatorEmail}}),recipient=await tx.userAccount.findFirstOrThrow({where:{organizationId:org,email:reviewerEmail}});
      const owner=await tx.owner.create({data:{organizationId:org,displayName:`Dedicated payout owner ${suffix}`}}),unrelated=await tx.owner.create({data:{organizationId:org,displayName:`Unrelated private owner ${suffix}`}});
      const property=await tx.property.create({data:{organizationId:org,name:`Dedicated payout villa ${suffix}`,addressLine1:"Local acceptance",city:"Marrakech",timezone:"Europe/Paris",
        propertyType:"VILLA",bedrooms:1,bathrooms:1,maxGuests:2,amenities:[],photoUrls:[]}});
      await tx.propertyOwner.create({data:{organizationId:org,ownerId:owner.id,propertyId:property.id}});
      const finance=new FinanceRepository(tx,org),bank=await finance.ensureLedgerAccount({code:`PAYOUT_UI_BANK_${suffix.toUpperCase()}`,name:`Private company payout bank ${suffix}`,accountType:"ASSET_LOCATION",normalSide:"DEBIT"});
      const claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Owner payable",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
      const method=await tx.ownerPayoutMethod.create({data:{organizationId:org,ownerId:owner.id,label:`Dedicated owner recipient ${suffix}`,currency:"MAD",countryCode:"MA",methodType:"BANK_TRANSFER",
        accountHolderName:`Dedicated payout owner ${suffix}`,detailsEncrypted:encryptSecret("Dedicated nonproduction recipient reference"),maskedAccount:"****6789"}});
      const role=await tx.role.create({data:{organizationId:org,key:`payout_reviewer_${suffix}`,name:`Dedicated scoped payout reviewer ${suffix}`}});
      const permissions=await tx.permission.findMany({where:{organizationId:org,key:{in:["financial_transaction:view","financial_transaction:approve","financial_transaction:reject"]}}});expect(permissions).toHaveLength(3);
      await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:org,roleId:role.id,permissionId:permission.id}))});
      await tx.roleAssignment.updateMany({where:{organizationId:org,userAccountId:recipient.id,archivedAt:null},data:{archivedAt:new Date()}});
      await tx.roleAssignment.create({data:{organizationId:org,userAccountId:recipient.id,personId:recipient.personId,roleId:role.id,scopeType:"owner",scopeId:owner.id,validFrom:new Date("2020-01-01")}});
      const rules=new ConfigRuleRepository(tx,org);
      await rules.lockVersion("finance.accounting_periods","organization");
      const calendar=await rules.resolve({key:"finance.accounting_periods",scopes:[{scopeType:"organization",scopeId:null}]});
      if(!calendar)await rules.createVersion({key:"finance.accounting_periods",scopeType:"organization",effectiveFrom:new Date("2000-01-01"),reason:"Dedicated explicit native payout ledger calendar",
        value:{timezone:"UTC",allow_early_close:false,max_reopen_seconds:60}});
      await rules.createVersion({key:"finance.payout_schedule",scopeType:"property",scopeId:property.id,effectiveFrom:new Date("2020-01-01"),reason:"Dedicated native payout agreement",
        value:{cadence:"OTA_SPLIT_EXPECTED_SETTLEMENT",hold_days:0,holdback_bps:1000}});
      await rules.createVersion({key:"finance.approval_thresholds",scopeType:"property",scopeId:property.id,effectiveFrom:new Date("2020-01-01"),reason:"Dedicated configured owner payout review",
        value:{thresholds:[{key:"native_owner_payout",requires_approval_from:["owner"]}],routing:{owner:{roles:[role.id],people:[],assigned:false,channels:["in_app"]}}}});
      const amount=Money.of("10000.00","MAD"),at=await finance.clock();
      const opening=await finance.createFinancialTransaction({reference:`QA-PAYOUT-REVENUE:${suffix}`,idempotencyKey:randomUUID(),createdBy:author.id,occurredAt:at,description:"Dedicated native owner opening revenue",
        postings:[{ledgerAccountId:bank.id,side:"DEBIT",amount,bucket:"REVENUE_RECEIPT",dimensions:{owner_id:owner.id,property_id:property.id}},
          {ledgerAccountId:claim.id,side:"CREDIT",amount,bucket:"OWNER_REVENUE",dimensions:{owner_id:owner.id,property_id:property.id}}]});
      return{ownerId:owner.id,propertyId:property.id,unrelatedOwnerId:unrelated.id,bankId:bank.id,bankName:bank.name,methodId:method.id,openingId:opening.id,reviewerId:recipient.id};
    });
    const workspace=ownerPayoutWorkspacePath(locale,source.ownerId,source.propertyId),purpose=`Dedicated reviewed payout ${suffix}`;
    await operator.goto(`${origin}${ownerLedgerPath(locale,source.ownerId,source.propertyId)}`);await operator.getByTestId("owner-ledger-payouts").click();
    await expect(operator.getByTestId("payout-workspace-page")).toBeVisible();await expect(operator.getByTestId("payout-empty")).toBeVisible();
    const search=operator.getByTestId("payout-source-search");await search.locator('input[name="fundingQuery"]').fill(source.bankName);
    await search.getByRole("button").click();await expect(operator).toHaveURL(url=>url.searchParams.get("fundingQuery")===source.bankName);
    await expect(operator.getByTestId("payout-funding").locator(`option[value="${source.bankId}"]`)).toHaveCount(1);
    await operator.getByTestId("payout-funding").selectOption(source.bankId);await expect(operator.getByTestId("payout-funding")).toHaveValue(source.bankId);
    await operator.getByTestId("payout-amount").fill(locale==="ar"?"\u0665\u0660\u0660\u066b\u0662\u0665":"500,25");
    await operator.getByTestId("payout-method").selectOption(source.methodId);await operator.getByTestId("payout-purpose").fill(purpose);
    const expected=operator.getByTestId("payout-expected-settlement");await expected.locator("xpath=ancestor::details").locator("summary").click();
    await expected.fill("2026-03-07T12:00");await operator.getByTestId("payout-reason").fill("Dedicated native payout entry");
    expect((await new AxeBuilder({page:operator}).analyze()).violations).toEqual([]);
    await operator.getByTestId("payout-create").click();await expect(operator.getByTestId("payout-detail-page")).toBeVisible();
    const id=new URL(operator.url()).pathname.split("/").at(-1)!;
    await expect(operator.getByTestId("payout-total")).toHaveText(formatCurrencyAmount(locale,"500.25","MAD"));
    await operator.getByTestId("payout-submit-reason").fill("Dedicated agreed owner payout review");await operator.getByTestId("payout-submit").click();await expect(operator.getByTestId("payout-approval-link")).toBeVisible();
    const approval=await operator.getByTestId("payout-approval-link").getAttribute("href");expect(approval).toBeTruthy();
    await reviewer.goto(`${origin}${approval}`);await expect(reviewer.getByTestId("approval-financial-summary")).toBeVisible();
    expect(await reviewer.locator("body").innerText()).not.toContain(source.bankName);
    await reviewer.getByTestId("approval-reason").fill("Dedicated independent owner payout approval");await reviewer.getByTestId("approval-approve").click();await expect(reviewer.getByTestId("approval-approve")).toHaveCount(0);
    await operator.reload();await expect(operator.getByTestId("payout-schedule-form")).toBeVisible();
    // The browser is in Denver; the instruction is interpreted using the Paris property clock.
    await operator.getByTestId("payout-scheduled-local").fill("2026-03-07T12:00");await operator.getByTestId("payout-schedule-reason").fill("Dedicated agreed Paris payout date");
    await operator.getByTestId("payout-schedule").click();await expect(operator.getByTestId("payout-pay-form")).toBeVisible();
    await withTenant(db,org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id}});expect(row).toMatchObject({state:"SCHEDULED",version:4});
      expect(row.scheduledFor?.toISOString()).toBe("2026-03-07T11:00:00.000Z");expect(row.expectedSettlementAt?.toISOString()).toBe("2026-03-07T11:00:00.000Z");
      expect(await tx.financialTransaction.count({where:{reference:`PAYOUT:${id}`}})).toBe(0);
    });
    await operator.getByTestId("payout-payment-reference").fill(`QA-MANUAL-TRANSFER-${suffix}`);await operator.getByTestId("payout-pay-reason").fill("Dedicated completed external test transfer");
    const requestPromise=operator.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&Boolean(request.postData()?.includes(id)));
    await operator.getByTestId("payout-pay").click();const request=await requestPromise;
    await expect(operator.getByTestId("payout-recorded-reference")).toHaveText(`QA-MANUAL-TRANSFER-${suffix}`);
    const replay=await operator.request.post(request.url(),{data:request.postDataBuffer()!,headers:{"content-type":request.headers()["content-type"],"next-action":request.headers()["next-action"],accept:"text/x-component",origin}});
    const replayText=await replay.text();expect(replayText).toContain('"ok":true');expect(replayText).toContain('"idempotent":true');
    const denied=await reviewer.request.post(request.url(),{data:request.postDataBuffer()!,headers:{"content-type":request.headers()["content-type"],"next-action":request.headers()["next-action"],accept:"text/x-component",origin}});
    const denial=await denied.text();expect(denial).toContain('"ok":false');expect(denial).toContain('"code":"forbidden"');
    const foreign=await reviewer.request.get(`${origin}${ownerPayoutWorkspacePath(locale,source.unrelatedOwnerId,source.propertyId)}`);expect(foreign.status()).toBe(404);expect(await foreign.text()).not.toContain(purpose);
    await reviewer.goto(`${origin}/${locale}/app/payouts/${id}`);expect(await reviewer.locator("body").innerText()).not.toContain(source.bankName);await expect(reviewer.getByTestId("payout-reverse-form")).toHaveCount(0);await expect(reviewer.getByTestId("payout-ledger-link")).toHaveCount(0);
    expect((await new AxeBuilder({page:operator}).analyze()).violations).toEqual([]);expect((await new AxeBuilder({page:reviewer}).analyze()).violations).toEqual([]);
    await operator.getByRole("heading",{level:1}).evaluate(element=>{(element as HTMLElement).style.fontSize="96px";});
    expect(await operator.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
    await expect(operator.locator("html")).toHaveAttribute("dir",locale==="ar"?"rtl":"ltr");
    await operator.screenshot({path:info.outputPath(`native-owner-payout-${locale}.png`),fullPage:true});
    await operator.getByTestId("payout-ledger-link").click();await expect(operator.getByTestId("owner-ledger-closing")).toHaveText(formatCurrencyAmount(locale,"9499.75","MAD"));
    await operator.goto(`${origin}/${locale}/app/payouts/${id}`);const reversal=operator.getByTestId("payout-reverse-form");await reversal.locator("xpath=ancestor::details").locator("summary").click();
    await operator.getByTestId("payout-reverse-reason").fill("Dedicated native exact payment reversal");await operator.getByTestId("payout-reverse").click();await expect(operator.getByTestId("payout-reverse-form")).toHaveCount(0);
    await operator.getByTestId("payout-ledger-link").click();await expect(operator.getByTestId("owner-ledger-closing")).toHaveText(formatCurrencyAmount(locale,"10000.00","MAD"));
    await operator.goto(`${origin}${workspace}`);await expect(operator.getByTestId("payout-row")).toHaveCount(1);
    await withTenant(db,org,async tx=>{
      const row=await tx.ownerPayout.findUniqueOrThrow({where:{id},include:{transaction:{include:{postings:true}},reversalTransaction:{include:{postings:true}}}});
      expect(row.state).toBe("CANCELLED");expect(row.transaction?.postings).toHaveLength(2);expect(row.reversalTransaction?.postings).toHaveLength(2);
      expect(row.reversalTransaction?.reversesTransactionId).toBe(row.transactionId);expect(await tx.financialTransaction.count({where:{reference:`PAYOUT:${id}`}})).toBe(1);
      for(const action of ["created","submitted","approved","scheduled","paid","reversed"])expect(await tx.auditLog.count({where:{resourceId:id,action:`finance.owner_payout.${action}`}})).toBe(1);
    });
    expect(errors).toEqual([]);
  }finally{await reviewerContext.close();await db.$disconnect();}
});
