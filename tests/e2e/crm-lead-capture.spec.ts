import {randomUUID} from "node:crypto";
import {PrismaClient} from "@prisma/client";
import {test,expect,type Page} from "@playwright/test";
import {withTenant} from "@/platform/db/tenant";
import {bootstrapOrganizationId} from "@/platform/identity/bootstrap";
import {nativeLeadInput,nativeWebsiteLeadInput} from "../integration/support/lead-fixture";
import {configuredCapturePolicy} from "./support/crm-fixtures";
import {publicLeadFixtureOrganizationId} from "./support/crm-fixture-config";
import {e2eEmail,ensureE2EAdmin,completeE2EAdminMfa,waitForE2EAdminLoginWindow} from "./support/auth";

const post=(page:Page,path:string,input:unknown)=>page.evaluate(async({path,input})=>{const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});return{status:response.status,cache:response.headers.get("cache-control"),body:await response.json() as unknown};},{path,input});

for(const locale of ["en","fr","ar"]as const){
  test(`Public native assessment acknowledgement is private, durable and tenant-bound in ${locale}`,async({page})=>{
    test.setTimeout(120000);if(!process.env.DATABASE_URL)throw Error("Dedicated native PostgreSQL required");const db=new PrismaClient();
    try{
      await configuredCapturePolicy(db,publicLeadFixtureOrganizationId);await page.goto(`/${locale}`);const input={...nativeWebsiteLeadInput(),locale},first=await post(page,"/api/public/assessment-requests",input);
      expect(first).toEqual({status:202,cache:"private, no-store",body:{accepted:true}});expect(await post(page,"/api/public/assessment-requests",input)).toEqual(first);
      const saved=await withTenant(db,publicLeadFixtureOrganizationId,async tx=>({rows:await tx.lead.findMany({where:{commandKey:input.idempotencyKey}}),events:await tx.outboxEvent.findMany({where:{type:"crm.lead_captured",payload:{path:["sourceKey"],equals:input.sourceKey}}})}));
      expect(saved.rows).toHaveLength(1);const row=saved.rows[0];expect(row.organizationId).toBe(publicLeadFixtureOrganizationId);expect(row.channel).toBe("WEBSITE");expect(row.locale).toBe(locale);expect(Buffer.from(row.encryptedPayload).includes(Buffer.from(input.fields.email!))).toBe(false);
      expect(saved.events.filter(event=>(event.payload as {leadId:string}).leadId===row.id)).toHaveLength(1);
      expect((await post(page,"/api/crm/leads/read",{leadId:row.id})).status).toBe(401);
      expect(await post(page,"/api/public/assessment-requests",{...input,organizationId:bootstrapOrganizationId})).toMatchObject({status:400,body:{error:"validation"}});
      const audits=await withTenant(db,publicLeadFixtureOrganizationId,tx=>tx.auditLog.findMany({where:{resourceId:row.id,action:"crm.lead_captured"}}));expect(audits).toHaveLength(1);expect(audits[0].actorId).toBeNull();expect(JSON.stringify({first,audits})).not.toContain(input.fields.email);
    }finally{await db.$disconnect();}
  });
  test(`Authenticated manual/referral intake recovers lost acknowledgement and rechecks independent grants in ${locale}`,async({page,browser},info)=>{
    test.setTimeout(180000);if(!process.env.DATABASE_URL)throw Error("Dedicated native PostgreSQL required");const db=new PrismaClient(),email=e2eEmail("crm-"+locale+"-"+randomUUID().slice(0,8),info.project.name),password=process.env.ADMIN_PASSWORD??"correct horse battery staple";
    try{
      await ensureE2EAdmin(email,password);await configuredCapturePolicy(db,bootstrapOrganizationId);await page.goto("/en/login");await waitForE2EAdminLoginWindow(page,email);await page.getByTestId("login-email").fill(email);await page.getByTestId("login-password").fill(password);await page.getByTestId("login-submit").click();await completeE2EAdminMfa(page,email);await expect(page).toHaveURL(/\/en\/app/u);await page.goto(`/${locale}/app`);
      const account=await withTenant(db,bootstrapOrganizationId,tx=>tx.userAccount.findFirstOrThrow({where:{organizationId:bootstrapOrganizationId,email}}));
      const assignments=await withTenant(db,bootstrapOrganizationId,async tx=>{
        await tx.roleAssignment.updateMany({where:{organizationId:bootstrapOrganizationId,userAccountId:account.id,validTo:null},data:{validTo:new Date()}});const ids:Record<string,string>={};
        for(const action of ["create","view"]){const role=await tx.role.create({data:{organizationId:bootstrapOrganizationId,key:"crm_browser_"+action+"_"+randomUUID(),name:"Independent CRM browser "+action}}),permission=await tx.permission.findFirstOrThrow({where:{organizationId:bootstrapOrganizationId,key:"lead:"+action}});await tx.rolePermission.create({data:{organizationId:bootstrapOrganizationId,roleId:role.id,permissionId:permission.id}});const assignment=await tx.roleAssignment.create({data:{organizationId:bootstrapOrganizationId,roleId:role.id,userAccountId:account.id,personId:account.personId,scopeType:"organization",validFrom:new Date("2020-01-01")}});ids[action]=assignment.id;}return ids;
      });
      const input={...nativeLeadInput(),locale};let originalStatus:number|null=null;
      await page.route("**/api/crm/leads/capture",async route=>{const response=await route.fetch({maxRetries:0,maxRedirects:0});originalStatus=response.status();await route.abort("failed");},{times:1});
      const lost=await page.evaluate(async input=>{try{await fetch("/api/crm/leads/capture",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});return false;}catch{return true;}},input);expect(lost).toBe(true);expect(originalStatus).toBe(200);
      const recovered=await post(page,"/api/crm/leads/capture",input);expect(recovered).toMatchObject({status:200,cache:"private, no-store",body:{channel:"MANUAL",replayed:true}});const leadId=(recovered.body as {id:string}).id;
      expect(await post(page,"/api/crm/leads/read",{leadId})).toMatchObject({status:200,body:{id:leadId,fields:input.fields}});
      const referral={...nativeLeadInput({channel:"REFERRAL"}),locale};expect((await post(page,"/api/crm/leads/capture",referral)).status).toBe(200);
      const anonymous=await browser.newContext({storageState:{cookies:[],origins:[]}});try{const response=await anonymous.request.post(new URL("/api/crm/leads/read",page.url()).href,{headers:{Origin:new URL(page.url()).origin},data:{leadId}});expect(response.status()).toBe(401);}finally{await anonymous.close();}
      await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.update({where:{id:assignments.view},data:{validTo:new Date()}}));expect(await post(page,"/api/crm/leads/read",{leadId})).toMatchObject({status:403,body:{error:"forbidden"}});expect((await post(page,"/api/crm/leads/capture",input)).status).toBe(200);
      await withTenant(db,bootstrapOrganizationId,tx=>tx.roleAssignment.update({where:{id:assignments.create},data:{validTo:new Date()}}));expect((await post(page,"/api/crm/leads/capture",input)).status).toBe(403);
      const records=await withTenant(db,bootstrapOrganizationId,async tx=>({leads:await tx.lead.count({where:{commandKey:input.idempotencyKey}}),audits:await tx.auditLog.findMany({where:{resourceId:leadId,action:"crm.lead_captured"}}),events:await tx.outboxEvent.findMany({where:{idempotencyKey:"crm.lead.captured:"+leadId}})}));expect(records.leads).toBe(1);expect(records.audits).toHaveLength(1);expect(records.events).toHaveLength(1);expect(JSON.stringify(records)).not.toContain(input.fields.email);
    }finally{await db.$disconnect();}
  });
}
