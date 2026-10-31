import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {expect,test} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {authContextForAccount} from "@/platform/authz/account-context";
import {createCustomRole} from "@/modules/identity/application/identity-service";
import {e2eEmail,ensureE2EAdmin,waitForE2EAdminLoginWindow,completeE2EAdminMfa} from "./support/auth";

test("custom role editing stays responsive with a hundred actual role definitions",async({page},info)=>{
 test.skip(!process.env.DATABASE_URL,"Real local PostgreSQL required");test.setTimeout(180000);const db=new PrismaClient(),organizationId=bootstrapOrganizationId,suffix=randomUUID().slice(0,8),email=e2eEmail("role-editor-scale-"+suffix,info.project.name),password=process.env.ADMIN_PASSWORD??"correct horse battery staple";
 try{
  await ensureE2EAdmin(email,password);await page.goto("/en/login");await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);await page.getByTestId("login-submit").click();await completeE2EAdminMfa(page,email);await expect(page).toHaveURL(/\/en\/app/u);
  const account=await withTenant(db,organizationId,tx=>tx.userAccount.findUniqueOrThrow({where:{organizationId_email:{organizationId,email}}})),actor={organizationId,actorId:account.id,personId:account.personId,authContext:{...await authContextForAccount(organizationId,account.id,{db}),personId:account.personId}},names=Array.from({length:100},(_,index)=>"Actual role editor "+suffix+" "+String(index).padStart(3,"0"));
  for(const[index,name]of names.entries())await createCustomRole(actor,{name,key:"editor_scale_"+suffix+"_"+index,description:"Actual scoped permission definition for role-editor acceptance",permissionKeys:["property:view"]},{db});
  await page.goto("/en/app/identity");for(const name of[names[0],names.at(-1)!])await expect(page.getByTestId("role-catalog-row").filter({hasText:name})).toBeVisible();await expect(page.getByTestId("custom-role-edit-form")).toHaveCount(0);
  const target=names.at(-1)!,edited=target+" Updated",row=page.getByTestId("role-catalog-row").filter({hasText:target}),summary=row.locator("summary"),form=row.getByTestId("custom-role-edit-form"),permissionCount=await withTenant(db,organizationId,tx=>tx.permission.count({where:{organizationId}}));await summary.focus();await expect(summary).toBeFocused();await summary.press("Enter");await expect(form).toBeVisible();await expect(form.getByTestId("edit-custom-role-name")).toHaveValue(target);await expect(form.locator('input[name="permissionKeys"][value="property:view"]')).toBeChecked();expect(await page.locator('input[name="permissionKeys"]').count()).toBe(permissionCount*2);
  await form.getByTestId("edit-custom-role-name").fill(edited);await form.locator('input[name="permissionKeys"][value="task:view"]').check();await form.getByTestId("edit-custom-role-submit").click();await expect(form.getByRole("status")).toHaveText("Custom role updated.",{timeout:30000});
  const actual=await withTenant(db,organizationId,tx=>tx.role.findUniqueOrThrow({where:{organizationId_key:{organizationId,key:"editor_scale_"+suffix+"_99"}},include:{rolePermissions:{include:{permission:true}}}}));expect(actual.name).toBe(edited);expect(actual.rolePermissions.map(link=>link.permission.key).sort()).toEqual(["property:view","task:view"]);
  const draft="Retain the unsaved role description while reviewing another section";await form.locator('input[name="description"]').fill(draft);await summary.click();await expect(form).toBeHidden();await summary.click();await expect(form.locator('input[name="description"]')).toHaveValue(draft);await expect(page.getByTestId("custom-role-edit-form")).toHaveCount(1);expect((await new AxeBuilder({page}).include('[data-testid="custom-role-edit-form"]').analyze()).violations).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await db.$disconnect();}
});
