import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import { withTenant } from "@/platform/db/tenant";
import { ConfigRuleRepository } from "@/platform/config/config-rule-repository";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { accountantExportPolicyKey } from "@/modules/finance/domain/accountant-export-policy";
import { accountantReportKinds } from "@/modules/finance/domain/accountant-export";
import { Money } from "@/platform/money/money";
import { openFieldFixture } from "./support/field-fixture";

for(const locale of ["en","fr","ar"] as const)test(`Complete original accountant downloads preserve exact money and private access in ${locale}`,async({page,browser},info)=>{
 test.skip(!process.env.DATABASE_URL,"Dedicated native PostgreSQL required");test.setTimeout(240000);
 const f=await openFieldFixture(page,info,locale),headers={Origin:new URL(page.url()).origin},downloadPath="/api/finance/accountant-exports/download",editorPath="/api/finance/accountant-exports/editor";
 const pageErrors:string[]=[];page.on("pageerror",error=>pageErrors.push(error.name));
 const anonymous=await browser.newContext({baseURL:new URL(page.url()).origin,storageState:{cookies:[],origins:[]}});
 try{
  const source=await withTenant(f.db,f.organizationId,async tx=>{
   const task=await tx.operationTask.findUniqueOrThrow({where:{id:f.taskId}}),actorId=task.assignedToUserAccountId!,property=await tx.property.findUniqueOrThrow({where:{id:task.propertyId}}),owner=await tx.owner.create({data:{organizationId:f.organizationId,displayName:"Actual accountant browser owner "+randomUUID()}});
   await tx.propertyOwner.create({data:{organizationId:f.organizationId,propertyId:property.id,ownerId:owner.id}});
   await tx.organizationProfile.upsert({where:{organizationId:f.organizationId},update:{timezone:"UTC"},create:{organizationId:f.organizationId,brandName:"Actual accountant browser source",timezone:"UTC"}});
   const rules=new ConfigRuleRepository(tx,f.organizationId),finance=new FinanceRepository(tx,f.organizationId),suffix=randomUUID().replaceAll("-","").slice(0,12).toUpperCase();
   await rules.createVersion({key:accountantExportPolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:actorId,value:{source:"ORIGINAL_POSTED_FINANCIAL_SOURCES",reports:[...accountantReportKinds],formats:["CSV","EXCEL","PDF"],classifications:{income:{buckets:["ACCOUNTANT_BROWSER_REVENUE"],account_types:["ALVILLAS_OWN"],sides:["CREDIT"]},expenses:{buckets:["ACCOUNTANT_BROWSER_EXPENSE"],account_types:["ALVILLAS_OWN"],sides:["DEBIT"]}},capacity:{CSV:10000,EXCEL:10000,PDF:1000},rate_limit:{requests:1000,window_seconds:3600}},reason:"Explicit native browser accountant report classification and complete capacity"});
   const bank=await finance.ensureLedgerAccount({code:"ACCOUNTANT_BANK_"+suffix,name:"Actual accountant browser bank "+suffix,accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),income=await finance.ensureLedgerAccount({code:"ACCOUNTANT_REVENUE_"+suffix,name:"Actual accountant browser income",accountType:"ALVILLAS_OWN",normalSide:"CREDIT"}),cost=await finance.ensureLedgerAccount({code:"ACCOUNTANT_COST_"+suffix,name:"Actual accountant browser cost",accountType:"ALVILLAS_OWN",normalSide:"DEBIT"}),claim=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Actual accountant original owner claim",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
   const dimensions={property_id:property.id};
   await rules.createVersion({key:"finance.bank_statements",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:{source:"ORIGINAL_BANK_STATEMENT",accounts:[{account_code:bank.code,bank_id:"actual-accountant-browser-bank",branch_id:null,account_id:bank.id,account_type:"CHECKING",currency:"MAD",csv:null,ofx:true}],encoding:"UTF-8",max_bytes:1000000,max_rows:5000,matching:{date_window_days:0,amount_tolerance:"0.00",reference:"EXACT",admission:"EXPLICIT_REVIEW",ledger_effect:"NONE"},source_corrections:"APPEND_AND_REOPEN_REVIEW",duplicate_csv_without_id:"RETAIN_EVERY_ROW"},reason:"Actual original accountant browser bank binding without inferred location"});
   for(const[value,bucket,credit,debit]of[["9007199254740993.07","ACCOUNTANT_BROWSER_REVENUE",income.id,bank.id],["0.03","ACCOUNTANT_BROWSER_EXPENSE",bank.id,cost.id],["0.07","OWNER_REVENUE",claim.id,bank.id]]){
    const amount=Money.of(value,"MAD"),facts=bucket==="OWNER_REVENUE"?{...dimensions,owner_id:owner.id}:dimensions;
    await finance.createFinancialTransaction({reference:"ACCOUNTANT-BROWSER:"+randomUUID(),occurredAt:new Date("2031-05-03T12:00:00Z"),description:'=Original browser evidence <&> '+suffix,idempotencyKey:randomUUID(),createdBy:actorId,postings:[{ledgerAccountId:debit,side:"DEBIT",amount,bucket,dimensions:facts},{ledgerAccountId:credit,side:"CREDIT",amount,bucket,dimensions:facts}]});
   }
   return{actorId,property,owner,bank};
  });
  const original=()=>withTenant(f.db,f.organizationId,tx=>tx.$queryRaw`SELECT 'journal' AS kind,id::text,xmin::text FROM financial_transaction WHERE organization_id=${f.organizationId}::uuid UNION ALL SELECT 'posting',id::text,xmin::text FROM posting WHERE organization_id=${f.organizationId}::uuid ORDER BY kind,id`),before=await original();
  const input={kind:"TRANSACTIONS",format:"CSV",locale,fromOn:"2031-05-01",toOn:"2031-05-31",currency:"MAD",propertyId:source.property.id,reason:"Download complete actual original accountant browser records"};
  expect((await anonymous.request.post(editorPath,{headers,data:{locale}})).status()).toBe(401);expect((await anonymous.request.post(downloadPath,{headers,data:input})).status()).toBe(401);
  expect((await page.request.post(downloadPath,{headers:{Origin:"https://foreign.example.test"},data:input})).status()).toBe(403);expect((await page.request.post(downloadPath+"?unexpected=1",{headers,data:input})).status()).toBe(400);
  await page.goto(`/${locale}/app/finance/accountant-exports`);const form=page.getByTestId("accountant-export-form");await expect(form).toBeVisible();
  await page.getByTestId("accountant-from").fill(input.fromOn);await page.getByTestId("accountant-to").fill(input.toOn);await page.getByTestId("accountant-report").selectOption("TRANSACTIONS");
  await page.getByTestId("accountant-property-choices").locator('input').fill(source.property.name);await page.getByTestId("accountant-property-selection").selectOption(source.property.id);
  for(const format of["CSV","EXCEL",...locale==="ar"?[]:["PDF"]]){
   await page.getByTestId("accountant-format").selectOption(format);await page.getByTestId("accountant-reason").fill(input.reason);
   const event=page.waitForEvent("download");await page.getByTestId("accountant-download").click();const file=await event,path=await file.path();if(!path)throw Error("Actual downloaded accountant attachment required");const bytes=new Uint8Array(await readFile(path));
   expect(file.suggestedFilename()).toContain("-2031-05-01-2031-05-31-MAD.");
   if(format==="CSV"){const text=new TextDecoder().decode(bytes);expect(text).toContain("9007199254740993.07");expect(text).toContain(source.property.id);expect(text).toContain("'=");}
   else if(format==="EXCEL"){const archive=unzipSync(bytes),xml=Object.entries(archive).filter(([name])=>name.endsWith(".xml")).map(([,value])=>strFromU8(value)).join("\n");expect(xml).toContain("9007199254740993.07");expect(xml).not.toMatch(/<f(?:\s|>)/u);if(locale==="ar")expect(xml).toContain('rightToLeft="1"');}
   else expect(new TextDecoder().decode(bytes.slice(0,5))).toBe("%PDF-");
   await expect(page.getByTestId("accountant-export-result")).toBeVisible();
  }
  for(const kind of accountantReportKinds){const selected={...input,kind,...kind==="OWNER_STATEMENTS"?{ownerId:source.owner.id}:{}};if(["BANK_RECONCILIATION","SUPPLIER_PAYMENTS","STAFF_PAYMENTS"].includes(kind))delete(selected as {propertyId?:string}).propertyId;const response=await page.request.post(downloadPath,{headers,data:selected});expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toBe("private, no-store");expect(response.headers()["x-content-type-options"]).toBe("nosniff");const text=await response.text();expect(text).toContain("2031-05-01");if(kind==="OWNER_STATEMENTS")expect(text).toContain('"0.07"');}
  await page.getByTestId("accountant-format").selectOption("CSV");await page.getByTestId("accountant-report").selectOption("OWNER_STATEMENTS");await page.getByTestId("accountant-owner-choices").locator("input").fill(source.owner.displayName);await page.getByTestId("accountant-owner-selection").selectOption(source.owner.id);
  await page.getByTestId("accountant-reason").fill(input.reason);const ownerDownload=page.waitForEvent("download");await page.getByTestId("accountant-download").click();const ownerFile=await ownerDownload,ownerPath=await ownerFile.path();if(!ownerPath)throw Error("Actual original owner statement attachment required");expect(await readFile(ownerPath,"utf8")).toContain('"0.07"');
  await page.getByTestId("accountant-report").selectOption("BANK_RECONCILIATION");await page.getByTestId("accountant-bank-choices").locator("input").fill(source.bank.code);await page.getByTestId("accountant-bank-selection").selectOption(source.bank.id);
  await page.getByTestId("accountant-reason").fill(input.reason);const bankDownload=page.waitForEvent("download");await page.getByTestId("accountant-download").click();const bankFile=await bankDownload,bankPath=await bankFile.path();if(!bankPath)throw Error("Actual original bank attachment required");expect(await readFile(bankPath,"utf8")).toContain("9007199254740993.07");
  expect((await new AxeBuilder({page}).include("main").analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(pageErrors).toEqual([]);await page.screenshot({path:info.outputPath("accountant-export.png"),fullPage:true});expect(await original()).toEqual(before);
  await withTenant(f.db,f.organizationId,tx=>tx.roleAssignment.updateMany({where:{userAccountId:source.actorId,archivedAt:null},data:{archivedAt:new Date()}}));
  const denied=await page.request.post(downloadPath,{headers,data:input});expect(denied.status()).toBe(403);expect(denied.headers()["content-disposition"]).toBeUndefined();expect((await page.request.post(editorPath,{headers,data:{locale}})).status()).toBe(403);
  await page.getByTestId("accountant-reason").fill(input.reason);await page.getByTestId("accountant-download").click();await expect(form).toHaveCount(0);await expect(page.getByTestId("accountant-export-result")).toBeVisible();expect(await original()).toEqual(before);
 }finally{await anonymous.close();await f.db.$disconnect();}
});
