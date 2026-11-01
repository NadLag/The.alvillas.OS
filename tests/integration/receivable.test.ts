import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {writeAuditEvent} from "@/platform/audit/audit-writer";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {ReceivableRepository} from "@/modules/finance/infrastructure/receivable-repository";
import {receivableAccountBalances,receivablePolicyKey,ReceivableAccessError,ReceivablePolicyError} from "@/modules/finance/domain/receivable";
import {getReceivableSummary} from "@/modules/finance/application/receivable-summary-service";
import {ensureStandardIdentitySetup} from "@/modules/identity/application/identity-service";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {provisionIntegrationRole} from "./support/database-role";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
const range={startsAt:new Date("2026-03-01T00:00:00Z"),endsAt:new Date("2026-04-01T00:00:00Z"),currency:"MAD"};
const policy={source:"POSTED_OWNERSHIP_CLAIMS",account_codes:["CONFIGURED_GUEST_CLAIM"]};
async function fixture(){
  const org=await admin.organization.create({data:{name:"Independent original receivable movements"}});
  await ensureStandardIdentitySetup(org.id,{db});
  return withTenant(db,org.id,async tx=>{
    for(const code of["MAD","EUR"])await tx.currency.upsert({where:{code},update:{},create:{code,name:code,minorUnit:2}});
    const person=await tx.person.create({data:{organizationId:org.id,displayName:"Receivable accounting acceptance"}}),actor=await tx.userAccount.create({data:{organizationId:org.id,personId:person.id}}),finance=new FinanceRepository(tx,org.id);
    const claim=await finance.ensureLedgerAccount({code:policy.account_codes[0],name:"Original ownership claim",accountType:"CLAIM_OWNERSHIP",normalSide:"DEBIT"}),location=await finance.ensureLedgerAccount({code:"OTA_CLEARING_TEST",name:"Money location is independent",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}),counterpart=await finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Original counterpart ownership",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"});
    return{org:org.id,actor,claim,location,counterpart};
  });
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function journal(f:Fixture,at:string,amount:string,side:"DEBIT"|"CREDIT"="DEBIT",currency="MAD",accountId=f.claim.id){
  return withTenant(db,f.org,async tx=>{
    const result=await new FinanceRepository(tx,f.org).createFinancialTransaction({reference:"RECEIVABLE-QA:"+randomUUID(),description:"Original retained ownership movement",occurredAt:new Date(at),idempotencyKey:randomUUID(),createdBy:f.actor.id,
      postings:[{ledgerAccountId:accountId,side,amount:Money.of(amount,currency),bucket:"RECEIVABLE_QA",dimensions:{}},{ledgerAccountId:f.counterpart.id,side:side==="DEBIT"?"CREDIT":"DEBIT",amount:Money.of(amount,currency),bucket:"RECEIVABLE_QA",dimensions:{}}]});
    await writeAuditEvent(tx,{organizationId:f.org,actorId:f.actor.id,action:"finance.transaction.created",resourceType:"financial_transaction",resourceId:result.id,after:{transactionId:result.id,amount:Money.of(amount,currency).toJSON()},reason:"Retain attributed original receivable source",requestId:randomUUID(),occurredAt:await new FinanceRepository(tx,f.org).clock()});return result;
  });
}
const totals=(f:Fixture,input=range)=>withTenant(db,f.org,async tx=>receivableAccountBalances(await new ReceivableRepository(tx,f.org).accountTotals(policy,input),input.currency));
const filters={fromOn:"2026-03-01",toOn:"2026-03-31",timezone:"UTC",currency:"MAD"};
async function reader(f:Fixture,options:{permissions?:string[];scopeType?:string;scopeId?:string;conditions?:{maxAmount:string}}={}){
  const grant=await withTenant(db,f.org,async tx=>{
    const role=await tx.role.create({data:{organizationId:f.org,key:"receivable_reader_"+randomUUID(),name:"Explicit independent receivable authority"}});
    for(const key of options.permissions??["receivable:view","financial_transaction:view","staff_compensation:view"]){const permission=await tx.permission.findFirstOrThrow({where:{organizationId:f.org,key}});await tx.rolePermission.create({data:{organizationId:f.org,roleId:role.id,permissionId:permission.id}});}
    return tx.roleAssignment.create({data:{organizationId:f.org,personId:f.actor.personId,userAccountId:f.actor.id,roleId:role.id,scopeType:options.scopeType??"organization",scopeId:options.scopeId??null,conditions:options.conditions,validFrom:new Date("2000-01-01")}});
  });
  return{grant,ctx:{organizationId:f.org,actorId:f.actor.id,authContext:await authContextForAccount(f.org,f.actor.id,{db})}};
}
const configure=(f:Fixture)=>withTenant(db,f.org,tx=>new ConfigRuleRepository(tx,f.org).createVersion({key:receivablePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit original receivable ownership source"}));
const audits=(f:Fixture)=>withTenant(db,f.org,tx=>tx.auditLog.count({where:{action:"finance.receivables.viewed"}}));

describe.skipIf(!url)("receivable ownership sources on real PostgreSQL",()=>{
  beforeAll(async()=>{
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
  });
  afterAll(async()=>{vi.restoreAllMocks();await db?.$disconnect();await admin?.$disconnect();});
  it("resolves the explicitly effective-dated config rule without supplying account defaults",async()=>{
    const f=await fixture(),resolved=await withTenant(db,f.org,async tx=>{const configs=new ConfigRuleRepository(tx,f.org);expect(await configs.resolve({key:receivablePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:range.startsAt})).toBeNull();const saved=await configs.createVersion({key:receivablePolicyKey,scopeType:"organization",effectiveFrom:new Date("2020-01-01"),value:policy,reason:"Explicit original ownership account selection"});const result=await configs.resolve({key:receivablePolicyKey,scopes:[{scopeType:"organization",scopeId:null}],asOf:range.startsAt});return{saved,result};});
    expect(resolved.result?.id).toBe(resolved.saved.id);expect(resolved.result?.parsedValue).toEqual(policy);
  });
  it("retains configured accounts with no movements as exact zero",async()=>{
    const f=await fixture();expect(await totals(f)).toMatchObject({closingBalance:"0.00",rowCount:"0",accounts:[{id:f.claim.id,closingBalance:"0.00"}]});
  });
  it("derives original opening, partial credits and opposite movements without changing original rows or versions",async()=>{
    const f=await fixture(),original=await journal(f,"2026-02-28T23:59:59.999Z","9007199254740993.99");await journal(f,"2026-03-01T00:00:00Z","100.01");await journal(f,"2026-03-15T12:00:00Z","33.33","CREDIT");await journal(f,"2026-03-20T12:00:00Z","33.33");await journal(f,"2026-04-01T00:00:00Z","10000");
    const before=await withTenant(db,f.org,tx=>tx.$queryRaw`SELECT to_jsonb(p) AS original,p.xmin::text AS version FROM posting p WHERE p.organization_id=${f.org}::uuid AND p.transaction_id=${original.id}::uuid ORDER BY p.id`);
    expect(await totals(f)).toMatchObject({openingBalance:"9007199254740993.99",periodDebits:"133.34",periodCredits:"33.33",closingBalance:"9007199254741094.00",rowCount:"3"});
    expect(await withTenant(db,f.org,tx=>tx.$queryRaw`SELECT to_jsonb(p) AS original,p.xmin::text AS version FROM posting p WHERE p.organization_id=${f.org}::uuid AND p.transaction_id=${original.id}::uuid ORDER BY p.id`)).toEqual(before);
  });
  it("keeps money locations and currencies separate from ownership claims",async()=>{
    const f=await fixture();await journal(f,"2026-03-01T12:00:00Z","123.45");await journal(f,"2026-03-01T12:00:00Z","9999","DEBIT","MAD",f.location.id);await journal(f,"2026-03-01T12:00:00Z","500","DEBIT","EUR");
    expect(await totals(f)).toMatchObject({closingBalance:"123.45",rowCount:"1"});expect(await totals(f,{...range,currency:"EUR"})).toMatchObject({closingBalance:"500.00",rowCount:"1"});
    await expect(withTenant(db,f.org,tx=>new ReceivableRepository(tx,f.org).accountTotals({...policy,account_codes:[f.location.code]},range))).rejects.toThrow(/ownership accounts/u);
  });
  it("retains credit positions and archived-account history without creating a new liability",async()=>{
    const f=await fixture();await journal(f,"2026-03-01T12:00:00Z","1","CREDIT");await withTenant(db,f.org,tx=>tx.ledgerAccount.update({where:{id:f.claim.id},data:{archivedAt:new Date()}}));expect(await totals(f)).toMatchObject({closingBalance:"-1.00",rowCount:"1"});
  });
  it("rejects missing and liability-side accounts rather than silently accepting a partial configuration",async()=>{
    const f=await fixture();for(const account_codes of[[policy.account_codes[0],"NOT_AN_ACCOUNT"],[f.counterpart.code]])await expect(withTenant(db,f.org,tx=>new ReceivableRepository(tx,f.org).accountTotals({...policy,account_codes},range))).rejects.toThrow(/ownership accounts/u);
  });
  it("enforces real tenant isolation for configured accounts and original movements",async()=>{
    const f=await fixture(),foreign=await fixture();await journal(f,"2026-03-01T12:00:00Z","321.09");expect(await totals(foreign)).toMatchObject({closingBalance:"0.00",rowCount:"0"});expect(await withTenant(db,foreign.org,tx=>tx.posting.count({where:{organizationId:f.org}}))).toBe(0);expect(await db.posting.count()).toBe(0);
  });
  it("returns an explicitly authorized and attributed original ownership summary",async()=>{
    const f=await fixture(),r=await reader(f),rule=await configure(f);await journal(f,"2026-03-10T00:00:00Z","3320.02");const before=await withTenant(db,f.org,async tx=>({journals:await tx.financialTransaction.count(),postings:await tx.posting.count()}));
    expect(await getReceivableSummary(r.ctx,filters,{db})).toMatchObject({closingBalance:"3320.02",configRuleId:rule.id,configVersion:rule.version,rowCount:"1",accounts:[{id:f.claim.id,closingBalance:"3320.02"}]});expect(await audits(f)).toBe(1);expect(await withTenant(db,f.org,async tx=>({journals:await tx.financialTransaction.count(),postings:await tx.posting.count()}))).toEqual(before);
  });
  it.each([{permissions:[]},{permissions:["receivable:view"]},{permissions:["receivable:view","financial_transaction:view"]},{permissions:["financial_transaction:view","staff_compensation:view"]}])("denies missing independent financial or salary authority %j",async({permissions})=>{
    const f=await fixture(),r=await reader(f,{permissions});await configure(f);await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivableAccessError);expect(await audits(f)).toBe(0);
  });
  it("denies conditional and narrower aggregate grants even with all three permission keys",async()=>{
    for(const options of[{conditions:{maxAmount:"1000000000000000"}},{scopeType:"financial_record",scopeId:randomUUID()}]){const f=await fixture(),r=await reader(f,options);await configure(f);await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivableAccessError);expect(await audits(f)).toBe(0);}
  });
  it("retains original caller restrictions even when current stored authority becomes broader",async()=>{
    const f=await fixture(),r=await reader(f,{permissions:["receivable:view","financial_transaction:view"]});await reader(f);await configure(f);await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivableAccessError);expect(await audits(f)).toBe(0);
  });
  it("rejects a stored grant revoked after the original actor context was loaded",async()=>{
    const f=await fixture(),r=await reader(f);await configure(f);await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:r.grant.id},data:{validTo:new Date("2020-01-02")}}));await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivableAccessError);expect(await audits(f)).toBe(0);
  });
  it("rejects missing effective configuration and actor/tenant substitution",async()=>{
    const f=await fixture(),r=await reader(f),foreign=await fixture();await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivablePolicyError);await expect(getReceivableSummary({...r.ctx,organizationId:foreign.org},filters,{db})).rejects.toBeInstanceOf(ReceivableAccessError);expect(await audits(f)).toBe(0);
  });
  it("rolls back the private read audit when authority is revoked at the final boundary",async()=>{
    const f=await fixture(),r=await reader(f);await configure(f);const original=Reflect.get<FinanceRepository,"clock">(FinanceRepository.prototype,"clock");let calls=0;
    const spy=vi.spyOn(FinanceRepository.prototype,"clock").mockImplementation(async function(this:FinanceRepository){const at=await original.call(this);calls++;if(calls===4)await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:r.grant.id},data:{validTo:new Date("2020-01-02")}}));return at;});
    try{await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivableAccessError);}finally{spy.mockRestore();}expect(calls).toBe(4);expect(await audits(f)).toBe(0);
  });
  it("rejects a newly published rule after reading rather than returning a stale source selection",async()=>{
    const f=await fixture(),r=await reader(f);await configure(f);const original=Reflect.get<ReceivableRepository,"accountTotals">(ReceivableRepository.prototype,"accountTotals"),spy=vi.spyOn(ReceivableRepository.prototype,"accountTotals").mockImplementationOnce(async function(this:ReceivableRepository,config,input){const result=await original.call(this,config,input);await configure(f);return result;});
    try{await expect(getReceivableSummary(r.ctx,filters,{db})).rejects.toBeInstanceOf(ReceivablePolicyError);}finally{spy.mockRestore();}expect(await audits(f)).toBe(0);
  });
});
