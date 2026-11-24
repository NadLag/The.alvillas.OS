import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {test,expect} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {nativePrivateReplies} from "./support/native-service-replies";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {inventoryStockPageSchema} from "@/modules/inventory/domain/stock-levels";
import {e2eEmail,ensureE2EAccount,waitForE2EAdminLoginWindow,completeE2EAdminMfa} from "./support/auth";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};
const messages={en,fr,ar},fixtureSchema=z.object({itemId:z.uuid(),itemKey:z.string(),sourceId:z.uuid(),sourceLabel:z.string(),destinationId:z.uuid(),destinationLabel:z.string()}).passthrough();
for(const locale of["en","fr","ar"]as const)test("Derived original stock levels and private per-source totals in "+locale,async({page},info)=>{
 test.setTimeout(600000);const target=new URL(process.env.DATABASE_URL??"invalid:");if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname==="/alvillas_automation_inventory_movements_20261117"||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned migrated stock level browser database required");
 const reply=await nativePrivateReplies(page,"/api/inventory/stock/"),db=new PrismaClient(),email=e2eEmail("derived-stock-"+locale+"-"+randomUUID(),info.project.name),password=process.env.ADMIN_PASSWORD??"correct horse battery staple",m=messages[locale].InventoryStockLevels,pickerCopy=messages[locale].InventoryMovements,errors:string[]=[];page.on("pageerror",error=>errors.push(error.name));page.setDefaultTimeout(30000);if(info.project.name==="field-mobile")await page.setViewportSize({width:360,height:800});
 try{
  await ensureE2EAccount(email,password,{permissionKeys:["inventory_movement:view","inventory_movement:create","inventory_item:view","inventory_location:view","property:view"],page});const account=await withTenant(db,bootstrapOrganizationId,tx=>tx.userAccount.findUniqueOrThrow({where:{organizationId_email:{organizationId:bootstrapOrganizationId,email}}}));
  await page.goto("/en/login");await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);await page.getByTestId("login-submit").click();await Promise.all([page.waitForURL(/\/en\/app/u),completeE2EAdminMfa(page,email)]);
  const output=info.outputPath("derived-stock-fixture.private.json");await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/inventory-movement-fixture-worker.ts"),JSON.stringify({organizationId:bootstrapOrganizationId,accountId:account.id,personId:account.personId,guestLocale:locale,stock:true,output})],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});const f=fixtureSchema.parse(JSON.parse(await readFile(output,"utf8")));
  await page.goto("/"+locale+"/app/inventory/stock");const panel=page.getByTestId("inventory-stock-manager");await expect(panel).toContainText(m.chooseHelp);
  async function choose(label:string,kind:"LOCATION"|"ITEM"){
   await panel.getByRole("button",{name:kind==="LOCATION"?m.chooseLocation:m.chooseItem,exact:true}).click();const picker=page.getByTestId("inventory-movement-source-picker");await picker.getByLabel(pickerCopy.search,{exact:true}).fill(label);await picker.getByRole("button",{name:pickerCopy.searchAction,exact:true}).click();const response=reply("page");await picker.getByRole("button").filter({hasText:label}).first().click();const actual=await response;expect(actual.status()).toBe(200);expect(actual.headers()["cache-control"]).toContain("no-store");return inventoryStockPageSchema.parse(await actual.json());
  }
  await choose(f.sourceLabel,"LOCATION");await panel.getByLabel(m.search,{exact:true}).fill(f.itemKey);let response=reply("page");await panel.getByRole("button",{name:m.apply,exact:true}).click();const atLocation=inventoryStockPageSchema.parse(await(await response).json());expect(atLocation.totals).toBeNull();expect(atLocation.items).toHaveLength(1);expect(atLocation.items[0]).toMatchObject({item:{id:f.itemId},location:{id:f.sourceId},position:{quantity:"16",reserved:"0",damaged:"2",available:"14"}});await expect(panel.getByTestId("inventory-stock-row")).toHaveCount(1);await expect(panel).toContainText(m.separateUnits);
  await panel.getByLabel(m.view,{exact:true}).selectOption("ITEM");const byItem=await choose(f.itemKey,"ITEM");expect(byItem.totals).toMatchObject({quantity:"20",reserved:"0",damaged:"2",available:"18",shortage:"0"});await expect(panel.getByTestId("inventory-stock-totals")).toContainText(new Intl.NumberFormat(locale).format(20));await panel.getByLabel(m.search,{exact:true}).fill(f.sourceLabel);response=reply("page");await panel.getByRole("button",{name:m.apply,exact:true}).click();const filtered=inventoryStockPageSchema.parse(await(await response).json());expect(filtered.totals).toMatchObject({quantity:"16",damaged:"2",available:"14",locationCount:"1"});await expect(panel.getByTestId("inventory-stock-row")).toHaveCount(1);
  expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath("derived-stock-"+locale+".png"),fullPage:true});
  await page.context().setOffline(true);await expect(panel).toContainText(m.states.offline);await expect(panel.getByTestId("inventory-stock-row")).toHaveCount(0);await page.context().setOffline(false);await expect(panel).toContainText(m.chooseHelp);await choose(f.itemKey,"ITEM");
  const scope=bootstrapOrganizationId+"."+account.id;expect((await page.request.post("/api/inventory/stock/page",{data:{mode:"ITEM",itemId:f.itemId},headers:{"x-alvillas-inventory-scope":scope,Origin:"https://foreign.invalid"}})).status()).toBe(403);
  await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.updateMany({where:{organizationId:bootstrapOrganizationId,userAccountId:account.id},data:{archivedAt:new Date()}}));response=reply("page");await panel.getByRole("button",{name:m.refresh,exact:true}).click();expect((await response).status()).toBe(403);await expect(panel.getByTestId("inventory-stock-row")).toHaveCount(0);await expect(panel).toContainText(m.states.forbidden);expect(await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).not.toContain(f.itemKey);expect(errors).toEqual([]);
 }finally{await page.context().setOffline(false);await db.$disconnect();}
});
