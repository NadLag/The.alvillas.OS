import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect,test } from "@playwright/test";
import { z } from "zod";
import { withTenant } from "@/platform/db/tenant";
import { Money } from "@/platform/money/money";
import { openFieldFixture } from "./support/field-fixture";

test.use({timezoneId:"America/Denver",serviceWorkers:"allow",actionTimeout:30000,navigationTimeout:60000});
for(const locale of ["en","fr","ar"] as const)test(`Native bank transfers preserve ownership and exact reasoned reversals in ${locale}`,async({page,browser},info)=>{
  test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(240000);
  if(!["localhost","127.0.0.1"].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error("Isolated local PostgreSQL required");
  const f=await openFieldFixture(page,info,"en"),suffix=randomUUID().slice(0,8),purpose=`Dedicated native bank location transfer ${suffix}`,origin=new URL(page.url()).origin;
  const anonymous=await browser.newContext({baseURL:origin,storageState:{cookies:[],origins:[]}});
  try{
    const actorId=z.object({user:z.object({id:z.uuid()})}).parse(await(await page.request.get("/api/auth/session")).json()).user.id;
    const banks: Array<{id:string}>=[];
    for(const label of ["source","destination"]){
      const name=`Dedicated native ${label} bank ${suffix}`;
      await page.goto(`/${locale}/app/finance/accounts`);await page.getByTestId("payment-account-name").fill(name);await page.getByTestId("payment-account-kind").selectOption("BANK");
      await page.getByTestId("payment-account-reason").fill("Dedicated native bank location acceptance");await page.getByTestId("payment-account-create").click();await expect(page.getByTestId("payment-account-saved")).toBeVisible();
      banks.push(await withTenant(f.db,f.organizationId,tx=>tx.ledgerAccount.findFirstOrThrow({where:{name}})));
    }
    expect(await withTenant(f.db,f.organizationId,tx=>tx.posting.count({where:{ledgerAccountId:{in:banks.map(bank=>bank.id)}}}))).toBe(0);
    await page.goto(`/${locale}/app/finance/transfers?from=${banks[0].id}&to=${banks[1].id}`);
    await expect(page.getByTestId("transfer-submit")).toBeEnabled();await page.getByTestId("transfer-kind").selectOption("TRANSFER");await page.getByTestId("transfer-amount").fill(locale==="en"?"1234.56":"1234,56");await page.getByTestId("transfer-currency").selectOption("MAD");
    await page.getByTestId("transfer-purpose").fill(purpose);await page.getByTestId("transfer-reason").fill("Dedicated authorized bank location movement");
    const captured=page.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&Boolean(request.postData()?.includes(purpose)));
    await page.getByTestId("transfer-submit").click();const request=await captured;await expect(page.getByTestId("transfer-saved")).toBeVisible();
    const headers={"content-type":request.headers()["content-type"],"next-action":request.headers()["next-action"],accept:"text/x-component",origin};
    const validBody=request.postData()!;
    expect(validBody).toContain('"amount":"1234.56"');
    const invalidBody=validBody.replace('"amount":"1234.56"','"amount":"invalid"');
    expect(await(await page.request.post(request.url(),{data:invalidBody,headers})).text()).toContain('"code":"validation"');
    for(const response of await Promise.all(Array.from({length:4},()=>page.request.post(request.url(),{data:request.postDataBuffer()!,headers}))))expect(await response.text()).toContain('"idempotent":true');
    expect(await(await anonymous.request.post(request.url(),{data:request.postDataBuffer()!,headers})).text()).toContain('"code":"forbidden"');
    const original=await withTenant(f.db,f.organizationId,async tx=>{
      const rows=await tx.financialTransaction.findMany({where:{description:purpose},include:{postings:{orderBy:{id:"asc"},include:{ledgerAccount:true}}}});expect(rows).toHaveLength(1);
      const row=rows[0];expect(row.createdBy).toBe(actorId);expect(row.postings).toHaveLength(2);expect(row.postings.every(line=>line.currency==="MAD"&&line.bucket==="TRANSFER"&&line.ledgerAccount.accountType==="ASSET_LOCATION")).toBe(true);
      expect(row.postings.find(line=>line.ledgerAccountId===banks[0].id)?.side).toBe("CREDIT");expect(row.postings.find(line=>line.ledgerAccountId===banks[1].id)?.side).toBe("DEBIT");
      expect(row.postings.every(line=>Money.of(line.amount.toString(),line.currency).toJSON().amount==="1234.56")).toBe(true);
      expect(await tx.auditLog.count({where:{action:"finance.transfer.posted",resourceId:row.id,actorId:row.createdBy}})).toBe(1);return row;
    });
    const row=page.getByTestId("transfer-row").filter({hasText:purpose});
    while(!await row.count()){
      const next=page.getByTestId("transfer-history-next");if(!await next.count())break;
      await page.goto((await next.getAttribute("href"))!);
    }
    const form=row.getByTestId("transfer-void-form"),reason="Dedicated bank transfer recorded in error";
    await form.locator('[name="reason"]').fill(reason);
    const undoCaptured=page.waitForRequest(request=>request.method()==="POST"&&Boolean(request.headers()["next-action"])&&Boolean(request.postData()?.includes(original.id))&&Boolean(request.postData()?.includes(reason)));
    await form.getByRole("button").click();const undo=await undoCaptured;await expect(form).toHaveCount(0);
    const undoHeaders={...headers,"content-type":undo.headers()["content-type"],"next-action":undo.headers()["next-action"]};
    for(const response of await Promise.all(Array.from({length:4},()=>page.request.post(undo.url(),{data:undo.postDataBuffer()!,headers:undoHeaders}))))expect(await response.text()).toContain('"idempotent":true');
    await withTenant(f.db,f.organizationId,async tx=>{
      expect(await tx.financialTransaction.findUniqueOrThrow({where:{id:original.id},include:{postings:{orderBy:{id:"asc"},include:{ledgerAccount:true}}}})).toEqual(original);
      const reversals=await tx.financialTransaction.findMany({where:{reversesTransactionId:original.id}});expect(reversals).toHaveLength(1);
      const lines=await tx.posting.findMany({where:{ledgerAccountId:{in:banks.map(bank=>bank.id)}}});expect(lines).toHaveLength(4);
      for(const bank of banks)expect(lines.filter(line=>line.ledgerAccountId===bank.id).reduce((sum,line)=>line.side==="DEBIT"?sum.add(Money.of(line.amount.toString(),line.currency)):sum.subtract(Money.of(line.amount.toString(),line.currency)),Money.zero("MAD")).toJSON().amount).toBe("0.00");
      expect(await tx.auditLog.count({where:{action:"finance.transfer.reversed",resourceId:original.id,actorId:original.createdBy}})).toBe(1);
    });
    expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);await page.evaluate(()=>document.documentElement.style.fontSize="200%");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.evaluate(()=>document.documentElement.style.fontSize="");await expect(page.locator("html")).toHaveAttribute("dir",locale==="ar"?"rtl":"ltr");await page.screenshot({path:info.outputPath(`native-bank-transfer-${locale}.png`),fullPage:true});
  }finally{await anonymous.close();await f.db.$disconnect()}
});
