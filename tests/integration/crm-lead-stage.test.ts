import {randomBytes,randomUUID} from "node:crypto";
import {PrismaClient,type Prisma} from "@prisma/client";
import {z} from "zod";
import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {withTenant,type TenantTransaction,type TenantTransactionRunner} from "@/platform/db/tenant";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {hashRateLimitKey} from "@/platform/rate-limit/postgres-rate-limiter";
import * as auditWriter from "@/platform/audit/audit-writer";
import {readLead} from "@/modules/crm/application/lead-capture-service";
import {reviewLeadStage,admitLeadStage,recoverLeadStage,readLeadStageHistory} from "@/modules/crm/application/lead-stage-service";
import {nativeLeadStageFixture,nativeLeadStagePolicy} from "./support/lead-fixture";
import {provisionIntegrationRole} from "./support/database-role";

let admin:PrismaClient,db:PrismaClient,financialBefore:unknown;
const env={NODE_ENV:"test" as const,ENCRYPTION_KEYS:"native-stage:"+randomBytes(32).toString("base64")},deps=()=>({db,env});
const financialTuples=()=>admin.$queryRaw`SELECT 'journal' AS kind,id::text,xmin::text,md5(to_jsonb(t)::text) AS body FROM financial_transaction t UNION ALL SELECT 'posting',id::text,xmin::text,md5(to_jsonb(t)::text) FROM posting t ORDER BY kind,id`;
beforeAll(async()=>{const url=process.env.TEST_DATABASE_URL,target=url?new URL(url):null;if(!target||!["localhost","127.0.0.1"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Owned native stage database required");admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username=scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});financialBefore=await financialTuples();});
afterAll(async()=>{vi.restoreAllMocks();try{if(admin)expect(await financialTuples()).toEqual(financialBefore);}finally{await db?.$disconnect();await admin?.$disconnect();}});
type Fixture=Awaited<ReturnType<typeof nativeLeadStageFixture>>;
const fixture=(changes:Parameters<typeof nativeLeadStagePolicy>[0]={})=>nativeLeadStageFixture(admin,db,env,changes);
const withdraw=(f:Fixture,kind:string)=>withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.assignments[kind]},data:{validTo:new Date("2020-01-02")}}));
const original=(f:Fixture)=>withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT id::text,xmin::text,md5(to_jsonb(t)::text) AS body FROM lead t WHERE organization_id=${f.organizationId}::uuid AND id=${f.lead.id}::uuid`);
const counts=(f:Fixture)=>withTenant(db,f.organizationId,async tx=>({stages:await tx.leadStageRevision.count(),audits:await tx.auditLog.count({where:{action:"crm.lead_stage_recorded"}}),events:await tx.outboxEvent.count({where:{type:"crm.lead_stage_recorded"}})}));
const historySchema=z.object({leadId:z.uuid(),stage:z.string(),revisionId:z.uuid().nullable(),stageHistory:z.array(z.object({id:z.uuid(),number:z.number(),reason:z.string(),fromStage:z.string(),toStage:z.string()})),next:z.number().nullable()});
const history=async(f:Fixture,before?:number)=>historySchema.parse(await readLeadStageHistory(f.ctx,{leadId:f.lead.id,...before?{before}:{}},deps()));
async function command(f:Fixture,toStage:"NEW"|"CONTACTED"|"QUALIFIED"|"PROPERTY_ASSESSMENT"|"PROPOSAL"="CONTACTED"){
  const current=await history(f),draft={leadId:f.lead.id,previousRevisionId:current.revisionId,toStage},review=await reviewLeadStage(f.ctx,draft,deps());return{...draft,idempotencyKey:randomUUID(),reviewFingerprint:review.reviewFingerprint,reason:"Actual reviewed private stage decision"};
}

describe("actual immutable lead pipeline admissions",()=>{
  it("advances the first native stages while preserving the original capture and exact financial history",async()=>{
    const f=await fixture(),before=await original(f);for(const toStage of["CONTACTED","QUALIFIED","PROPERTY_ASSESSMENT"]as const)expect((await admitLeadStage(f.ctx,await command(f,toStage),deps())).toStage).toBe(toStage);
    const result=await history(f);expect(result.stage).toBe("PROPERTY_ASSESSMENT");expect(result.stageHistory.map(row=>row.number)).toEqual([3,2,1]);expect(await readLead(f.ctx,{leadId:f.lead.id},deps())).toMatchObject({initialStage:"NEW",stage:"PROPERTY_ASSESSMENT",fields:f.input.fields});expect(await original(f)).toEqual(before);expect(await financialTuples()).toEqual(financialBefore);expect(await counts(f)).toEqual({stages:3,audits:3,events:3});
  });
  it("appends an explicit backward correction and never overwrites an original stage or reason",async()=>{
    const f=await fixture();await admitLeadStage(f.ctx,await command(f),deps());await admitLeadStage(f.ctx,await command(f,"QUALIFIED"),deps());const before=await withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT id::text,xmin::text,md5(to_jsonb(t)::text) AS body FROM lead_stage_revision t ORDER BY number`);await admitLeadStage(f.ctx,{...await command(f,"NEW"),reason:"Explicit reviewed acquisition correction"},deps());const rows=await history(f);expect(rows.stage).toBe("NEW");expect(rows.stageHistory[0].reason).toBe("Explicit reviewed acquisition correction");expect(await withTenant(db,f.organizationId,tx=>tx.$queryRaw`SELECT id::text,xmin::text,md5(to_jsonb(t)::text) AS body FROM lead_stage_revision t WHERE number<3 ORDER BY number`)).toEqual(before);
  });
  it("recovers an exact lost acknowledgement after independent edit withdrawal",async()=>{
    const f=await fixture(),input=await command(f),saved=await admitLeadStage(f.ctx,input,deps());await withdraw(f,"edit");expect(await admitLeadStage(f.ctx,input,deps())).toEqual({...saved,replayed:true});expect(await recoverLeadStage(f.ctx,{idempotencyKey:input.idempotencyKey},deps())).toEqual({recorded:true,revision:{...saved,replayed:true}});expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("serializes simultaneous exact retries into one native movement and audit/outbox",async()=>{
    const f=await fixture(),input=await command(f),results=await Promise.all([admitLeadStage(f.ctx,input,deps()),admitLeadStage(f.ctx,input,deps())]);expect(new Set(results.map(row=>row.id)).size).toBe(1);expect(results.map(row=>row.replayed).sort()).toEqual([false,true]);expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("recovers the same original nonce when a client explicitly sends an empty reference list",async()=>{
    const f=await fixture(),input=await command(f),saved=await admitLeadStage(f.ctx,input,deps());expect(await admitLeadStage(f.ctx,{reason:input.reason,reviewFingerprint:input.reviewFingerprint,idempotencyKey:input.idempotencyKey,evidenceReferences:[],toStage:input.toStage,previousRevisionId:input.previousRevisionId,leadId:input.leadId},deps())).toEqual({...saved,replayed:true});expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("admits only one command against the same reviewed predecessor",async()=>{
    const f=await fixture(),first=await command(f),results=await Promise.allSettled([admitLeadStage(f.ctx,first,deps()),admitLeadStage(f.ctx,{...first,idempotencyKey:randomUUID()},deps())]);expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(1);expect(results.filter(row=>row.status==="rejected")).toHaveLength(1);expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("rejects a changed private reason or selection under an admitted nonce",async()=>{
    const f=await fixture(),input=await command(f);await admitLeadStage(f.ctx,input,deps());for(const changed of[{...input,reason:"Changed confidential reason"},{...input,toStage:"QUALIFIED"}])await expect(admitLeadStage(f.ctx,changed,deps())).rejects.toThrow("lead_pipeline_changed");expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it.each(["view","edit"])("requires current stored %s authority independently",async kind=>{
    const f=await fixture(),input=await command(f);await withdraw(f,kind);await expect(admitLeadStage(f.ctx,input,deps())).rejects.toThrow("lead_unavailable");expect(await counts(f)).toEqual({stages:0,audits:0,events:0});
  });
  it.each(["view","edit"])("never borrows %s authority absent from the held capability",async kind=>{
    const f=await fixture(),input=await command(f),key="lead:"+kind,held={...f.ctx,authContext:{...f.ctx.authContext,permissions:new Set([...f.ctx.authContext.permissions].filter(value=>value!==key)),assignments:f.ctx.authContext.assignments?.map(row=>({...row,permissions:new Set([...row.permissions].filter(value=>value!==key))}))}};await expect(admitLeadStage(held,input,deps())).rejects.toThrow("lead_unavailable");expect(await counts(f)).toEqual({stages:0,audits:0,events:0});
  });
  it.each(["view","edit"])("checks actual %s conditions at both source and destination stages",async kind=>{
    const f=await fixture(),input=await command(f);await withTenant(db,f.organizationId,tx=>tx.roleAssignment.update({where:{id:f.assignments[kind]},data:{conditions:{statuses:["NEW"]}}}));await expect(admitLeadStage(f.ctx,input,deps())).rejects.toThrow("lead_unavailable");expect(await counts(f)).toEqual({stages:0,audits:0,events:0});
  });
  it("keeps tenant history, encrypted reasons and recovery receipts inside their actual tenant",async()=>{
    const own=await fixture(),other=await fixture(),input=await command(own),saved=await admitLeadStage(own.ctx,input,deps());await expect(readLeadStageHistory(other.ctx,{leadId:own.lead.id},deps())).rejects.toThrow("lead_unavailable");expect(await withTenant(db,other.organizationId,tx=>tx.leadStageRevision.findMany({where:{id:saved.id}}))).toEqual([]);expect(await recoverLeadStage(other.ctx,{idempotencyKey:input.idempotencyKey},deps())).toEqual({recorded:false,revision:null});
  });
  it("keeps the committed configured budget after a reviewed-fingerprint rejection",async()=>{
    const f=await fixture({admission:{requests:1,window_seconds:3600}}),input=await command(f);await expect(admitLeadStage(f.ctx,{...input,reviewFingerprint:"f".repeat(64)},deps())).rejects.toThrow("lead_pipeline_changed");await expect(admitLeadStage(f.ctx,input,deps())).rejects.toThrow("lead_rate_limited");const buckets=await withTenant(db,f.organizationId,tx=>tx.rateLimitBucket.findMany({where:{keyHash:hashRateLimitKey("crm.pipeline:organization")}}));expect(buckets).toHaveLength(1);expect(buckets[0].count).toBe(2);expect(await counts(f)).toEqual({stages:0,audits:0,events:0});
  });
  it("does not expose private reason or contact text in native audit and outbox records",async()=>{
    const f=await fixture(),reason="Private acquisition decision "+randomUUID(),saved=await admitLeadStage(f.ctx,{...await command(f),reason},deps()),rows=await withTenant(db,f.organizationId,async tx=>({stage:await tx.leadStageRevision.findFirstOrThrow({where:{id:saved.id}}),audits:await tx.auditLog.findMany({where:{resourceId:f.lead.id}}),events:await tx.outboxEvent.findMany({where:{type:"crm.lead_stage_recorded"}})}));expect(Buffer.from(rows.stage.reasonCipher).includes(Buffer.from(reason))).toBe(false);const visible=JSON.stringify({audits:rows.audits,events:rows.events});expect(visible).not.toContain(reason);expect(visible).not.toContain(f.input.fields.email);expect((await history(f)).stageHistory[0].reason).toBe(reason);
  });
  it("paginates the complete immutable history without repeating or dropping native revisions",async()=>{
    const f=await fixture();for(let index=0;index<23;index++)await admitLeadStage(f.ctx,await command(f,index%2?"NEW":"CONTACTED"),deps());const first=await history(f),second=await history(f,first.next!);expect(first.stageHistory.map(row=>row.number)).toEqual(Array.from({length:20},(_,index)=>23-index));expect(second.stageHistory.map(row=>row.number)).toEqual([3,2,1]);expect(second.next).toBeNull();expect(new Set([...first.stageHistory,...second.stageHistory].map(row=>row.id)).size).toBe(23);
  });
  it("retains original reason ciphertext through actual retained-key rotation",async()=>{
    const f=await fixture(),saved=await admitLeadStage(f.ctx,await command(f),deps()),before=await withTenant(db,f.organizationId,tx=>tx.leadStageRevision.findFirstOrThrow({where:{id:saved.id}})),rotated={...env,ENCRYPTION_KEYS:"next:"+randomBytes(32).toString("base64")+","+env.ENCRYPTION_KEYS};expect(historySchema.parse(await readLeadStageHistory(f.ctx,{leadId:f.lead.id},{db,env:rotated})).stageHistory[0].reason).toBe("Actual reviewed private stage decision");const after=await withTenant(db,f.organizationId,tx=>tx.leadStageRevision.findFirstOrThrow({where:{id:saved.id}}));expect(Buffer.compare(Buffer.from(before.reasonCipher),Buffer.from(after.reasonCipher))).toBe(0);expect(after.reasonSha256).toBe(before.reasonSha256);
  });
  it("protects every native stage record against updates and deletion",async()=>{
    const f=await fixture(),saved=await admitLeadStage(f.ctx,await command(f),deps());await expect(admin.leadStageRevision.update({where:{id:saved.id},data:{toStage:"NEW"}})).rejects.toThrow("append-only");await expect(admin.leadStageRevision.delete({where:{id:saved.id}})).rejects.toThrow("append-only");expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("rejects a native row without its matching atomic audit",async()=>{
    const f=await fixture(),saved=await admitLeadStage(f.ctx,await command(f),deps()),row=await withTenant(db,f.organizationId,tx=>tx.leadStageRevision.findFirstOrThrow({where:{id:saved.id}}));await expect(withTenant(db,f.organizationId,tx=>tx.leadStageRevision.create({data:{...row,id:randomUUID(),previousId:row.id,number:2,fromStage:"CONTACTED",toStage:"QUALIFIED",commandKey:randomUUID(),policySnapshot:row.policySnapshot as Prisma.InputJsonValue,authorizationCap:row.authorizationCap as Prisma.InputJsonValue,evidence:row.evidence as Prisma.InputJsonValue}}))).rejects.toThrow("atomic private actor audit");expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("requires actual proposal/contract evidence instead of trusting stage completion flags",async()=>{
    const f=await fixture();for(const stage of["CONTACTED","QUALIFIED","PROPERTY_ASSESSMENT"]as const)await admitLeadStage(f.ctx,await command(f,stage),deps());await expect(reviewLeadStage(f.ctx,{leadId:f.lead.id,previousRevisionId:(await history(f)).revisionId,toStage:"PROPOSAL"},deps())).rejects.toThrow("lead_pipeline_native_evidence_required");await expect(reviewLeadStage(f.ctx,{leadId:f.lead.id,previousRevisionId:(await history(f)).revisionId,toStage:"PROPOSAL",completed:true},deps())).rejects.toThrow();expect(await counts(f)).toEqual({stages:3,audits:3,events:3});
  });
  it("rolls back a movement and its atomic receipts after late stored edit withdrawal",async()=>{
    const f=await fixture(),input=await command(f),write=auditWriter.writeAuditEvent;let changed=false;const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await write(tx,event);if(!changed&&event.action==="crm.lead_stage_recorded"){changed=true;await withdraw(f,"edit");}return result;});try{await expect(admitLeadStage(f.ctx,input,deps())).rejects.toThrow("lead_unavailable");}finally{spy.mockRestore();}expect(changed).toBe(true);expect(await counts(f)).toEqual({stages:0,audits:0,events:0});
  });
  it("withholds private history after view withdrawal at its actual audit boundary",async()=>{
    const f=await fixture();await admitLeadStage(f.ctx,await command(f),deps());const write=auditWriter.writeAuditEvent;let changed=false;const spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await write(tx,event);if(!changed&&event.action==="crm.lead_stage_history_read"){changed=true;await withdraw(f,"view");}return result;});try{await expect(readLeadStageHistory(f.ctx,{leadId:f.lead.id},deps())).rejects.toThrow("lead_unavailable");}finally{spy.mockRestore();}expect(changed).toBe(true);expect(await counts(f)).toEqual({stages:1,audits:1,events:1});
  });
  it("rolls back the movement after its native policy changes at the final audit boundary",async()=>{
    const f=await fixture(),input=await command(f),write=auditWriter.writeAuditEvent;let active:TenantTransaction|null=null,changed=false;
    const observed:TenantTransactionRunner={$transaction:(work,options)=>db.$transaction(async tx=>{active=tx;try{return await work(tx);}finally{active=null;}},options)},spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{const result=await write(tx,event);if(!changed&&event.action==="crm.lead_stage_recorded"){changed=true;if(!active)throw Error("Actual stage transaction required");await new ConfigRuleRepository(active,f.organizationId).createVersion({key:"crm.pipeline",scopeType:"organization",createdBy:f.account.id,effectiveFrom:new Date("2020-01-01"),value:nativeLeadStagePolicy({admission:{requests:99,window_seconds:3600}}),reason:"Actual late configured stage admission replacement"});}return result;});
    try{await expect(admitLeadStage(f.ctx,input,{...deps(),db:observed})).rejects.toThrow("lead_pipeline_changed");}finally{spy.mockRestore();}expect(changed).toBe(true);expect(await counts(f)).toEqual({stages:0,audits:0,events:0});
  });
});
