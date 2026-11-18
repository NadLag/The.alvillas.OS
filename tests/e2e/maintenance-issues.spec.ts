import {randomUUID} from "node:crypto";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {resolve} from "node:path";
import {readFile} from "node:fs/promises";
import {PrismaClient} from "@prisma/client";
import {z} from "zod";
import {test,expect} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {MaintenanceIssueContextRepository} from "@/modules/maintenance/infrastructure/issue-context-repository";
import {maintenanceIssueLinkPublishedSchema} from "@/modules/maintenance/domain/issue-context";
import {workOrderRegistrationPublishedSchema} from "@/modules/maintenance/domain/work-order";
import {WorkOrderRepository} from "@/modules/maintenance/infrastructure/work-order-repository";
import {nativePrivateReplies} from "./support/native-service-replies";
import {acknowledgementBarrier} from "./support/acknowledgement-barrier";
import {e2eEmail,ensureE2EAccount,waitForE2EAdminLoginWindow,completeE2EAdminMfa} from "./support/auth";
import en from "../../messages/en.json" with {type:"json"};
import fr from "../../messages/fr.json" with {type:"json"};
import ar from "../../messages/ar.json" with {type:"json"};

test.describe.configure({retries:0});
const messages={en,fr,ar},fixtureSchema=z.object({issueId:z.uuid(),taskId:z.uuid(),title:z.string(),propertyId:z.uuid(),propertyLabel:z.string(),supplierId:z.uuid(),supplierLabel:z.string(),supplierGrantId:z.uuid(),workOrderTaskId:z.uuid(),workOrderTitle:z.string(),financialCount:z.number(),stockCount:z.number(),original:z.record(z.string(),z.unknown())}).strict();
for(const locale of["en","fr","ar"]as const)test("Native maintenance context, immutable recovery and independent source privacy in "+locale,async({page},info)=>{
 test.setTimeout(360000);
 const target=new URL(process.env.DATABASE_URL??"invalid:");if(process.env.VERCEL||process.env.VERCEL_ENV||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned migrated maintenance browser database required");
 const db=new PrismaClient(),reply=await nativePrivateReplies(page,"/api/maintenance/issues/"),email=e2eEmail("native-maintenance-"+locale+"-"+randomUUID(),info.project.name),password=process.env.ADMIN_PASSWORD??"correct horse battery staple",m=messages[locale].MaintenanceIssues,errors:string[]=[];
 page.on("pageerror",error=>errors.push(error.name));page.setDefaultTimeout(30000);if(info.project.name==="field-mobile")await page.setViewportSize({width:360,height:800});
 try{
  await ensureE2EAccount(email,password,{permissionKeys:["task:view","task:edit","issue:view","issue:create","issue:edit","property:view","audit_log:view","expense:view","expense:create","expense:approve","expense:reject","asset:view","asset:create","asset:edit","asset_cost:view","asset_cost:edit"],page});
  const account=await withTenant(db,bootstrapOrganizationId,tx=>tx.userAccount.findUniqueOrThrow({where:{organizationId_email:{organizationId:bootstrapOrganizationId,email}}})),output=info.outputPath("native-maintenance-fixture.private.json");
  await promisify(execFile)(process.execPath,[resolve("node_modules/tsx/dist/cli.mjs"),resolve("tests/e2e/support/maintenance-issue-fixture-worker.ts"),JSON.stringify({organizationId:bootstrapOrganizationId,accountId:account.id,personId:account.personId,guestLocale:locale,output})],{env:process.env,windowsHide:true,timeout:120000,maxBuffer:2*1024*1024});const f=fixtureSchema.parse(JSON.parse(await readFile(output,"utf8")));
  await page.goto("/en/login");await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);await page.getByTestId("login-submit").click();await Promise.all([page.waitForURL(/\/en\/app/u),completeE2EAdminMfa(page,email)]);

  const assetTag = "PUMP-" + randomUUID().slice(0, 8).toUpperCase();
  let registeredAsset = "";
  if (locale === "en") {
    await page.goto("/en/app/assets/new?" + new URLSearchParams({ q: f.propertyLabel }));
    const assetForm = page.getByTestId("asset-form");
    await assetForm.locator('select[name="propertyId"]').selectOption(f.propertyId);
    await assetForm.locator('input[name="tag"]').fill(assetTag);
    await assetForm.locator('input[name="name"]').fill("Original pool pump");
    await assetForm.locator('input[name="category"]').fill("Pool equipment");
    await assetForm.locator('select[name="condition"]').selectOption("GOOD");
    await assetForm.locator('input[name="purchaseOn"]').fill("2026-11-18");
    await assetForm.locator('input[name="amount"]').fill("250.05");
    await assetForm.locator('input[name="currency"]').fill("MAD");
    await assetForm.locator('input[name="usefulLifeMonths"]').fill("120");
    await assetForm.locator('textarea[name="reason"]').fill("Register the original installed pump through the asset workspace");
    await assetForm.getByRole("button", { name: en.Assets.save }).click();
    await expect(page.getByTestId("asset-detail")).toContainText(assetTag, { timeout: 15000 });
    registeredAsset = new URL(page.url()).pathname;
  }
  await page.goto("/"+locale+"/app/maintenance/issues/"+f.issueId);const panel=page.getByTestId("maintenance-issue-manager"),editor=panel.getByTestId("maintenance-issue-link-editor");await expect(panel.getByTestId("maintenance-issue-detail")).toContainText(f.title);await expect(panel.getByRole("link",{name:m.originalTask,exact:true})).toHaveAttribute("href","/"+locale+"/app/operations/"+f.taskId);
  await editor.getByRole("combobox",{name:m.recordType,exact:true}).selectOption("SUPPLIER");await editor.getByLabel(m.searchLabel,{exact:true}).fill(f.supplierLabel);await editor.getByRole("button",{name:m.search,exact:true}).click();await editor.getByTestId("maintenance-issue-choices").getByRole("button",{name:f.supplierLabel,exact:true}).click();
  const reason="Private original maintenance supplier context "+randomUUID();await editor.getByLabel(m.reason,{exact:true}).fill(reason);await editor.getByRole("button",{name:m.review,exact:true}).click();await expect(panel.getByTestId("maintenance-issue-review")).toContainText(f.supplierLabel);
  const committed=acknowledgementBarrier(),recovery=reply("recover");let writes=0,captured:ReturnType<typeof maintenanceIssueLinkPublishedSchema.parse>|undefined;
  await page.route("**/api/maintenance/issues/publish",async route=>{try{writes++;const original=await route.fetch({maxRetries:0,maxRedirects:0});expect(original.status()).toBe(200);captured=maintenanceIssueLinkPublishedSchema.parse(await original.json());await route.abort();committed.resolve();}catch(error){committed.reject(error);throw error;}},{times:1});
  await panel.getByTestId("maintenance-issue-review").getByRole("button",{name:m.publish,exact:true}).click();await committed.promise;expect(await(await recovery).json()).toMatchObject({recorded:true,receipt:{contextId:captured!.contextId}});await expect(panel).toContainText(m.saved);await expect(panel.getByTestId("maintenance-issue-sources")).toContainText(f.supplierLabel);expect(writes).toBe(1);
  await editor.getByRole("combobox",{name:m.recordType,exact:true}).selectOption("PROPERTY");await editor.getByRole("button",{name:m.search,exact:true}).click();await editor.getByTestId("maintenance-issue-choices").getByRole("button",{name:f.propertyLabel,exact:true}).click();await editor.getByLabel(m.reason,{exact:true}).fill("Link the original property without copying any original financial records");await editor.getByRole("button",{name:m.review,exact:true}).click();let published=reply("publish");await panel.getByTestId("maintenance-issue-review").getByRole("button",{name:m.publish,exact:true}).click();expect((await published).status()).toBe(200);await expect(panel.getByTestId("maintenance-issue-sources")).toContainText(f.propertyLabel);
  await panel.getByTestId("maintenance-issue-sources").getByRole("listitem").filter({hasText:f.propertyLabel}).getByRole("button",{name:m.unlink,exact:true}).click();await editor.getByLabel(m.reason,{exact:true}).fill("Remove the property link while retaining its original attributed history");await editor.getByRole("button",{name:m.reviewUnlink,exact:true}).click();published=reply("publish");await panel.getByTestId("maintenance-issue-review").getByRole("button",{name:m.publish,exact:true}).click();expect((await published).status()).toBe(200);await expect(panel.getByTestId("maintenance-issue-sources")).not.toContainText(f.propertyLabel);
  await panel.getByRole("button",{name:m.showHistory,exact:true}).click();const history=panel.getByTestId("maintenance-issue-history");await expect(history.getByRole("listitem")).toHaveCount(3);await expect(history).toContainText(reason);expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath("maintenance-context-"+locale+".png"),fullPage:true});
  const orders=panel.getByTestId("maintenance-work-orders"),orderEditor=orders.getByTestId("maintenance-work-order-editor"),orderReply=await nativePrivateReplies(page,"/api/maintenance/work-orders/");await orderEditor.getByLabel(m.workOrders.searchLabel,{exact:true}).fill(f.workOrderTitle);await orderEditor.getByRole("button",{name:m.search,exact:true}).click();await orderEditor.getByTestId("maintenance-work-order-choices").getByRole("button",{name:f.workOrderTitle,exact:true}).click();await orderEditor.getByLabel(m.reason,{exact:true}).fill("Link the original maintenance task without duplicating assignment, evidence or money");await orderEditor.getByRole("button",{name:m.review,exact:true}).click();await expect(orders.getByTestId("maintenance-work-order-review")).toContainText(f.workOrderTitle);
  const orderCommitted=acknowledgementBarrier(),orderRecovery=orderReply("recover");let orderWrites=0;await page.route("**/api/maintenance/work-orders/publish",async route=>{try{orderWrites++;const original=await route.fetch({maxRetries:0,maxRedirects:0});expect(original.status()).toBe(200);expect(workOrderRegistrationPublishedSchema.parse(await original.json())).toMatchObject({taskId:f.workOrderTaskId,intent:{issueId:f.issueId}});await route.abort();orderCommitted.resolve();}catch(error){orderCommitted.reject(error);throw error;}},{times:1});await orders.getByTestId("maintenance-work-order-review").getByRole("button",{name:m.workOrders.register,exact:true}).click();await orderCommitted.promise;expect(await(await orderRecovery).json()).toMatchObject({recorded:true,receipt:{taskId:f.workOrderTaskId}});await expect(orders.getByTestId("maintenance-work-order-list")).toContainText(f.workOrderTitle);expect(orderWrites).toBe(1);await expect(orders.getByRole("link",{name:m.workOrders.manage,exact:true})).toHaveAttribute("href","/"+locale+"/app/operations/"+f.workOrderTaskId);
  await page.reload();
  await expect(orders.getByTestId("maintenance-work-order-list")).toContainText(f.workOrderTitle, { timeout: 30000 });

  if (registeredAsset) {
    const assets = orders.getByRole("region", { name: m.assetLink.title });
    await assets.getByRole("button", { name: m.assetLink.manage }).click();
    await assets.getByRole("searchbox").fill(assetTag);
    await assets.getByRole("button", { name: m.search, exact: true }).click();
    await assets.getByRole("radio", { name: "Original pool pump", exact: true }).check();
    await assets.getByLabel(m.reason).fill("Link the original registered asset to the real work order");
    await assets.getByRole("button", { name: m.assetLink.link, exact: true }).click();
    await expect(assets.getByRole("link", { name: new RegExp(assetTag, "u") })).toHaveAttribute("href", registeredAsset);
  }
  await orders.getByRole("button", { name: m.finance.open, exact: true }).click();
  const costForm = orders.getByTestId("maintenance-finance-form");
  await costForm.getByLabel(m.finance.amount).fill(locale === "fr" ? "126,10" : "126.10");
  await costForm.getByLabel(m.finance.currency).fill("MAD");
  await costForm.getByLabel(m.finance.date).fill("2026-11-18");
  await costForm.getByLabel(m.finance.category).fill("maintenance");
  await costForm.getByLabel(m.finance.purpose).fill("Repair the original electric pump");
  await costForm.getByLabel(m.reason).fill("Review the original contractor estimate before authorizing work");
  await costForm.getByRole("button", { name: m.review, exact: true }).click();
  const financeReview = orders.getByTestId("maintenance-finance-review");
  await expect(financeReview).toContainText(m.finance.owner);
  await expect(financeReview).toContainText(m.finance.alvillas);
  await financeReview.getByRole("button", { name: m.finance.save, exact: true }).click();
  await expect(orders.getByText(m.finance.approvalStates.PENDING, { exact: true })).toBeVisible();
  await orders.getByRole("link", { name: m.finance.openApproval, exact: true }).click();
  await expect(page.getByTestId("approval-financial-summary")).toBeVisible();
  await page.getByTestId("approval-reason").fill("Approved contractor scope and confirmed allocation");
  await page.getByTestId("approval-approve").click();
  await expect(page.getByTestId("approval-state")).toHaveText(messages[locale].Approvals.states.APPROVED);
  await page.goto("/" + locale + "/app/maintenance/issues/" + f.issueId);
  await orders.getByRole("button", { name: m.finance.open, exact: true }).click();
  await expect(orders.getByText(m.finance.approvalStates.APPROVED, { exact: true })).toBeVisible();expect(await withTenant(db,bootstrapOrganizationId,tx=>tx.operationTask.count({where:{organizationId:bootstrapOrganizationId,propertyId:f.propertyId,type:"MAINTENANCE"}}))).toBe(1);expect(await withTenant(db,bootstrapOrganizationId,tx=>new WorkOrderRepository(tx,bootstrapOrganizationId).original(f.workOrderTaskId))).toMatchObject({taskId:f.workOrderTaskId,intent:{issueId:f.issueId}});expect((await new AxeBuilder({page}).analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath("maintenance-work-order-"+locale+".png"),fullPage:true});
  await page.context().setOffline(true);await expect(panel).toContainText(m.states.offline);await expect(panel.getByTestId("maintenance-issue-detail")).toHaveCount(0);await expect(history).toHaveCount(0);await page.context().setOffline(false);await expect(panel.getByTestId("maintenance-issue-detail")).toContainText(f.title);
  await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.update({where:{id:f.supplierGrantId},data:{archivedAt:new Date()}}));await panel.getByRole("button",{name:m.refresh,exact:true}).click();await expect(panel.getByTestId("maintenance-issue-sources")).toContainText(m.maskedSource);await expect(panel).not.toContainText(f.supplierLabel);await panel.getByRole("button",{name:m.showHistory,exact:true}).click();await expect(history.getByRole("listitem")).toHaveCount(3);await expect(history).not.toContainText(reason);await expect(history).not.toContainText(f.supplierLabel);
  const scope=bootstrapOrganizationId+"."+account.id;expect((await page.request.post("/api/maintenance/issues/read",{data:{issueId:f.issueId},headers:{"x-alvillas-inventory-scope":scope,Origin:"https://foreign.invalid"}})).status()).toBe(403);
  const retained=await withTenant(db,bootstrapOrganizationId,async tx=>({financialCount:await tx.financialTransaction.count({where:{organizationId:bootstrapOrganizationId}}),stockCount:await tx.inventoryMovement.count({where:{organizationId:bootstrapOrganizationId}}),original:z.record(z.string(),z.unknown()).parse(JSON.parse(JSON.stringify(await tx.operationIssue.findUniqueOrThrow({where:{id:f.issueId}})))),history:await new MaintenanceIssueContextRepository(tx,bootstrapOrganizationId).history(f.issueId)}));expect(retained.original).toEqual(f.original);expect(retained.financialCount).toBe(f.financialCount);expect(retained.stockCount).toBe(f.stockCount);expect(retained.history).toHaveLength(3);
  await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.updateMany({where:{organizationId:bootstrapOrganizationId,userAccountId:account.id},data:{archivedAt:new Date()}}));const denied=reply("read");await panel.getByRole("button",{name:m.refresh,exact:true}).click();expect((await denied).status()).toBe(403);await expect(panel).toContainText(m.states.forbidden);await expect(panel.getByTestId("maintenance-issue-detail")).toHaveCount(0);const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));expect(storage).not.toContain(reason);expect(storage).not.toContain(f.supplierLabel);expect(errors).toEqual([]);
 }finally{await page.context().setOffline(false);await page.context().unrouteAll({behavior:"wait"});await db.$disconnect();}
});
