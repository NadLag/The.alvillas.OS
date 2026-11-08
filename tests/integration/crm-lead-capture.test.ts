import {randomBytes,randomUUID,createHash} from "node:crypto";
import {PrismaClient,type Prisma} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import * as auditWriter from "@/platform/audit/audit-writer";
import {captureLead,captureWebsiteLead,readLead} from "@/modules/crm/application/lead-capture-service";
import {leadCapturePolicyKey,type LeadCapturePolicy} from "@/modules/crm/domain/lead-capture";
import {provisionIntegrationRole} from "./support/database-role";
import {nativeLeadFixture,nativeLeadInput,nativeWebsiteLeadInput} from "./support/lead-fixture";

let admin:PrismaClient,db:PrismaClient,financialBefore:unknown;
const env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"native-lead:"+randomBytes(32).toString("base64")};
const deps=()=>({db,env});
const financialTuples=()=>admin.$queryRaw`SELECT 'journal' AS kind,id::text,xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t UNION ALL SELECT 'posting',id::text,xmin::text,md5(to_jsonb(t)::text) FROM posting t ORDER BY kind,id`;
beforeAll(async()=>{
  const url=process.env.TEST_DATABASE_URL;if(!url||!["127.0.0.1","localhost"].includes(new URL(url).hostname))throw Error("Owned native CRM database required");
  admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});financialBefore=await financialTuples();
});
afterAll(async()=>{vi.restoreAllMocks();try{if(admin)expect(await financialTuples()).toEqual(financialBefore);}finally{await db?.$disconnect();await admin?.$disconnect();}});
type Fixture=Awaited<ReturnType<typeof nativeLeadFixture>>;
const fixture=(changes:Partial<LeadCapturePolicy>={})=>nativeLeadFixture(admin,db,changes);
const withdraw=(f:Fixture,kind:string)=>withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.assignments[kind]},data:{validTo:new Date("2020-01-02")}}));
const policy=(f:Fixture,value:LeadCapturePolicy)=>withTenant(db,f.organizationId,tx=>new ConfigRuleRepository(tx,f.organizationId).createVersion({key:leadCapturePolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value,reason:"Actual independently approved CRM policy replacement"}));
const counts=(f:Fixture)=>withTenant(db,f.organizationId,async tx=>({leads:await tx.lead.count(),captures:await tx.auditLog.count({where:{action:"crm.lead_captured"}}),events:await tx.outboxEvent.count({where:{type:"crm.lead_captured"}})}));

describe("actual private native CRM acquisition capture",()=>{
  it.each(["MANUAL","REFERRAL","WEBSITE"]as const)("persists %s once with an encrypted original and actual atomic audit/outbox",async channel=>{
    const f=await fixture(),input=channel==="WEBSITE"?nativeWebsiteLeadInput():nativeLeadInput({channel});
    const result=channel==="WEBSITE"?await captureWebsiteLead(f.organizationId,input,deps()):await captureLead(f.ctx,input,deps());
    expect(result).toMatchObject({initialStage:"NEW",channel,replayed:false});
    const native=await withTenant(db,f.organizationId,async tx=>({lead:await tx.lead.findFirstOrThrow({where:{id:result.id}}),audit:await tx.auditLog.findFirstOrThrow({where:{resourceId:result.id,action:"crm.lead_captured"}}),event:await tx.outboxEvent.findFirstOrThrow({where:{idempotencyKey:"crm.lead.captured:"+result.id}})}));
    expect(native.lead.createdBy).toBe(f.account.id);expect(native.lead.policySnapshot).toEqual({id:f.rule.id,version:f.rule.version,value:f.rule.value});expect(native.lead.payloadSchemaVersion).toBe(1);
    expect(createHash("sha256").update(native.lead.encryptedPayload).digest("hex")).toBe(native.lead.payloadSha256);
    expect(Buffer.from(native.lead.encryptedPayload).includes(Buffer.from(input.fields.email!))).toBe(false);
    expect(native.audit.actorId).toBe(channel==="WEBSITE"?null:f.account.id);expect(native.audit.requestId).toBe(native.lead.requestId);
    expect(native.event.payload).toEqual({leadId:result.id,channel,sourceKey:input.sourceKey});
    expect(JSON.stringify({receipt:result,audit:native.audit,event:native.event})).not.toContain(input.fields.email);
    expect(await readLead(f.ctx,{leadId:result.id},deps())).toMatchObject({id:result.id,fields:input.fields});expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it("canonicalizes an uppercase nonce for durable exact recovery",async()=>{
    const f=await fixture(),input=nativeLeadInput(),first=await captureLead(f.ctx,{...input,idempotencyKey:input.idempotencyKey.toUpperCase()},deps()),again=await captureLead(f.ctx,input,deps());
    expect(again).toEqual({...first,replayed:true});expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it("serializes simultaneous exact commands into one original capture",async()=>{
    const f=await fixture(),input=nativeLeadInput(),results=await Promise.all([captureLead(f.ctx,input,deps()),captureLead(f.ctx,input,deps())]);
    expect(new Set(results.map(row=>row.id)).size).toBe(1);expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it("rejects changed private fields under an already admitted nonce",async()=>{
    const f=await fixture(),input=nativeLeadInput();await captureLead(f.ctx,input,deps());await expect(captureLead(f.ctx,{...input,fields:{...input.fields,notes:"Different private command"}},deps())).rejects.toThrow("lead_command_conflict");expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it("recovers an original snapshot after its source choice is retired",async()=>{
    const f=await fixture(),input=nativeLeadInput(),saved=await captureLead(f.ctx,input,deps());await policy(f,{...f.policy,sources:[{...f.policy.sources[0],key:"replacement"}]});
    expect(await captureLead(f.ctx,input,deps())).toEqual({...saved,replayed:true});expect((await readLead(f.ctx,{leadId:saved.id},deps())).fields).toEqual(input.fields);
  });
  it("keeps a lost acknowledgement bound to its original actor",async()=>{
    const f=await fixture(),input=nativeLeadInput();await captureLead(f.ctx,input,deps());const other=await withTenant(db,f.organizationId,async tx=>{
      const person=await tx.person.create({data:{organizationId:f.organizationId,displayName:"Independent CRM operator"}}),account=await tx.userAccount.create({data:{organizationId:f.organizationId,personId:person.id}}),assignment=await tx.roleAssignment.findFirstOrThrow({where:{id:f.assignments.create}});
      await tx.roleAssignment.create({data:{organizationId:f.organizationId,userAccountId:account.id,personId:person.id,roleId:assignment.roleId,scopeType:"organization",validFrom:new Date("2020-01-01")}});return{person,account};
    });
    const ctx={organizationId:f.organizationId,actorId:other.account.id,authContext:{...await authContextForAccount(f.organizationId,other.account.id,{db}),personId:other.person.id}};
    await expect(captureLead(ctx,input,deps())).rejects.toThrow("lead_command_conflict");expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it("never automatically creates or associates an existing person, owner or property",async()=>{
    const f=await fixture(),input=nativeLeadInput();await withTenant(db,f.organizationId,tx=>tx.person.create({data:{organizationId:f.organizationId,displayName:input.fields.ownerContact!,email:input.fields.email}}));
    const before=await withTenant(db,f.organizationId,async tx=>({persons:await tx.person.count(),owners:await tx.owner.count(),properties:await tx.property.count()}));
    await captureLead(f.ctx,input,deps());expect(await withTenant(db,f.organizationId,async tx=>({persons:await tx.person.count(),owners:await tx.owner.count(),properties:await tx.property.count()}))).toEqual(before);
  });
  it.each(["create","view"])("rechecks independent stored %s authority",async kind=>{
    const f=await fixture(),input=nativeLeadInput(),saved=await captureLead(f.ctx,input,deps());await withdraw(f,kind);
    if(kind==="create")await expect(captureLead(f.ctx,input,deps())).rejects.toThrow("lead_unavailable");else await expect(readLead(f.ctx,{leadId:saved.id},deps())).rejects.toThrow("lead_unavailable");
  });
  it.each(["create","view"])("never borrows %s permission absent from the held authority",async kind=>{
    const f=await fixture(),saved=await captureLead(f.ctx,nativeLeadInput(),deps()),key="lead:"+kind;
    const held={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set([...f.ctx.authContext.permissions].filter(value=>value!==key)),assignments:f.ctx.authContext.assignments?.map(row=>({...row,permissions:new Set([...row.permissions].filter(value=>value!==key))}))}};
    if(kind==="create")await expect(captureLead(held,nativeLeadInput(),deps())).rejects.toThrow("lead_unavailable");else await expect(readLead(held,{leadId:saved.id},deps())).rejects.toThrow("lead_unavailable");
  });
  it.each(["create","configure"])("requires the actual website policy author to retain unconditional %s authority",async kind=>{
    const f=await fixture();await withdraw(f,kind);await expect(captureWebsiteLead(f.organizationId,nativeWebsiteLeadInput(),deps())).rejects.toThrow("lead_unavailable");expect(await counts(f)).toEqual({leads:0,captures:0,events:0});
  });
  it("does not use a conditional organization create grant for public admission",async()=>{
    const f=await fixture();await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.assignments.create},data:{conditions:{statuses:["NEW"]}}}));
    await expect(captureWebsiteLead(f.organizationId,nativeWebsiteLeadInput(),deps())).rejects.toThrow("lead_unavailable");expect(await counts(f)).toEqual({leads:0,captures:0,events:0});
  });
  it("commits the configured quota even when admission validation denies a command",async()=>{
    const f=await fixture({rate_limit:{requests:1,window_seconds:3600}}),invalid=nativeLeadInput({sourceKey:"unconfigured"});await expect(captureLead(f.ctx,invalid,deps())).rejects.toThrow("lead_validation");
    await expect(captureLead(f.ctx,nativeLeadInput(),deps())).rejects.toThrow("lead_rate_limited");const buckets=await withTenant(db,f.organizationId,tx=>tx.rateLimitBucket.findMany());expect(buckets).toHaveLength(1);expect(buckets[0].count).toBe(2);expect(await counts(f)).toEqual({leads:0,captures:0,events:0});
  });
  it("isolates original rows and recovery nonces between actual tenants",async()=>{
    const own=await fixture(),other=await fixture(),input=nativeLeadInput(),saved=await captureLead(own.ctx,input,deps());
    expect(await withTenant(db,other.organizationId,tx=>tx.lead.findMany({where:{id:saved.id}}))).toEqual([]);await expect(readLead(other.ctx,{leadId:saved.id},deps())).rejects.toThrow("lead_unavailable");
    expect((await captureLead(other.ctx,input,deps())).id).not.toBe(saved.id);expect(await counts(own)).toEqual({leads:1,captures:1,events:1});expect(await counts(other)).toEqual({leads:1,captures:1,events:1});
  });
  it("rejects an incoherent tenant or actor before writing anything",async()=>{
    const f=await fixture(),other=await fixture();await expect(captureLead({...f.ctx,organizationId:other.organizationId},nativeLeadInput(),deps())).rejects.toThrow("lead_unavailable");await expect(captureLead({...f.ctx,actorId:randomUUID()},nativeLeadInput(),deps())).rejects.toThrow("lead_unavailable");expect(await counts(f)).toEqual({leads:0,captures:0,events:0});
  });
  it.each(["manual-as-website","website-as-manual","changed-notice","unapproved-key"])("fails closed for %s",async mode=>{
    const f=await fixture(),input=nativeWebsiteLeadInput();
    if(mode==="manual-as-website")await expect(captureWebsiteLead(f.organizationId,nativeLeadInput(),deps())).rejects.toThrow("lead_validation");
    else if(mode==="website-as-manual")await expect(captureLead(f.ctx,input,deps())).rejects.toThrow("lead_validation");
    else if(mode==="changed-notice")await expect(captureWebsiteLead(f.organizationId,{...input,websiteAcknowledgement:{...input.websiteAcknowledgement,noticeSha256:"b".repeat(64)}},deps())).rejects.toThrow("lead_validation");
    else await expect(captureLead(f.ctx,{...nativeLeadInput(),organizationId:f.organizationId},deps())).rejects.toThrow();
    expect(await counts(f)).toEqual({leads:0,captures:0,events:0});
  });
  it("rejects update/delete even under the native database administrator",async()=>{
    const f=await fixture(),saved=await captureLead(f.ctx,nativeLeadInput(),deps());await expect(admin.lead.update({where:{id:saved.id},data:{locale:"en"}})).rejects.toThrow("append-only");await expect(admin.lead.delete({where:{id:saved.id}})).rejects.toThrow("append-only");expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it("rejects an otherwise valid native row without its actual atomic audit",async()=>{
    const f=await fixture(),saved=await captureLead(f.ctx,nativeLeadInput(),deps()),row=await withTenant(db,f.organizationId,tx=>tx.lead.findFirstOrThrow({where:{id:saved.id}}));
    await expect(withTenant(db,f.organizationId,tx=>tx.lead.create({data:{...row,id:randomUUID(),commandKey:randomUUID(),policySnapshot:row.policySnapshot as Prisma.InputJsonValue,authorizationCap:row.authorizationCap as Prisma.InputJsonValue}}))).rejects.toThrow("atomic private actor audit");expect(await counts(f)).toEqual({leads:1,captures:1,events:1});
  });
  it.each(["capture","read"]as const)("withholds %s after actual grant withdrawal at the audit boundary",async operation=>{
    const f=await fixture(),saved=operation==="read"?await captureLead(f.ctx,nativeLeadInput(),deps()):null,original=auditWriter.writeAuditEvent;let changed=false;
    const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await original(tx,event);if(!changed&&event.action===(operation==="read"?"crm.lead_read":"crm.lead_captured")){changed=true;await withdraw(f,operation==="read"?"view":"create");}return result;});
    try{if(saved)await expect(readLead(f.ctx,{leadId:saved.id},deps())).rejects.toThrow("lead_unavailable");else await expect(captureLead(f.ctx,nativeLeadInput(),deps())).rejects.toThrow("lead_unavailable");}finally{spy.mockRestore();}
    expect(changed).toBe(true);expect(await counts(f)).toEqual(saved?{leads:1,captures:1,events:1}:{leads:0,captures:0,events:0});expect(await withTenant(db,f.organizationId,tx=>tx.auditLog.count({where:{action:"crm.lead_read"}}))).toBe(0);
  });
  it("rolls back admission and its audit/outbox after a late native policy change",async()=>{
    const f=await fixture(),original=auditWriter.writeAuditEvent;let active:TenantTransaction|null=null,changed=false;
    const observed:TenantTransactionRunner={$transaction:(work,options)=>db.$transaction(async tx=>{active=tx;try{return await work(tx);}finally{active=null;}},options)};
    const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await original(tx,event);if(!changed&&event.action==="crm.lead_captured"){changed=true;if(!active)throw Error("Actual CRM transaction required");await new ConfigRuleRepository(active,f.organizationId).createVersion({key:leadCapturePolicyKey,scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:{...f.policy,processing_approval_reference:"independently replaced approval"},reason:"Actual late approval replacement"});}return result;});
    try{await expect(captureLead(f.ctx,nativeLeadInput(),{...deps(),db:observed})).rejects.toThrow("lead_command_conflict");}finally{spy.mockRestore();}expect(changed).toBe(true);expect(await counts(f)).toEqual({leads:0,captures:0,events:0});
  });
  it("fails closed on missing encryption keys and preserves original financial tuples",async()=>{
    const f=await fixture();await expect(captureLead(f.ctx,nativeLeadInput(),{db,env:{NODE_ENV:"test"}})).rejects.toThrow("lead_configuration_unavailable");expect(await counts(f)).toEqual({leads:0,captures:0,events:0});expect(await financialTuples()).toEqual(financialBefore);
  });
});
