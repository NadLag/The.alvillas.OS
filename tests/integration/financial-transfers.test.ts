import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { provisionIntegrationRole } from "./support/database-role";
import { withTenant } from "@/platform/db/tenant";
import { authContextForAccount } from "@/platform/authz/account-context";
import { ensureStandardIdentitySetup } from "@/modules/identity/application/identity-service";
import { postFinancialTransfer,voidFinancialTransfer,listFinancialTransfers,getFinancialTransferEditor,FinancialTransferAccessError,FinancialTransferConflictError,FinancialTransferConfigurationError } from "@/modules/finance/application/financial-transfer-service";
import { financialTransferPostings } from "@/modules/finance/domain/financial-transfer";
import { FinanceRepository } from "@/modules/finance/infrastructure/finance-repository";
import { writeAuditEvent } from "@/platform/audit/audit-writer";
import { Money } from "@/platform/money/money";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
async function fixture(scopedWallet=false){
  const org=randomUUID();await admin.organization.create({data:{id:org,name:"Dedicated native transfer integration",baseCurrency:"MAD"}});await ensureStandardIdentitySetup(org,{db});
  return withTenant(db,org,async tx=>{
    await tx.currency.upsert({where:{code:"MAD"},update:{},create:{code:"MAD",name:"Dirham",minorUnit:2}});
    const person=await tx.person.create({data:{organizationId:org,displayName:"Dedicated transfer operator"}});
    const user=await tx.userAccount.create({data:{organizationId:org,personId:person.id}}),employee=await tx.person.create({data:{organizationId:org,displayName:"Dedicated wallet recipient"}});
    const role=await tx.role.create({data:{organizationId:org,key:"dedicated_transfer",name:"Dedicated transfer authority"}});
    const keys=["financial_transaction:view","financial_transaction:create","financial_transaction:pay","financial_transaction:void",...(!scopedWallet?["wallet:view","wallet:pay","wallet:void"]:[])];
    const permissions=await tx.permission.findMany({where:{organizationId:org,key:{in:keys}}});expect(permissions).toHaveLength(keys.length);
    await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:org,roleId:role.id,permissionId:permission.id}))});
    const grant=await tx.roleAssignment.create({data:{organizationId:org,roleId:role.id,userAccountId:user.id,personId:person.id,scopeType:"organization",validFrom:new Date("2020-01-01")}});
    const bank=await tx.ledgerAccount.create({data:{organizationId:org,code:"DEDICATED_TRANSFER_BANK",name:"Dedicated bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}});
    const otherBank=await tx.ledgerAccount.create({data:{organizationId:org,code:"DEDICATED_TRANSFER_OTHER",name:"Dedicated second bank",accountType:"ASSET_LOCATION",normalSide:"DEBIT"}});
    const wallet=await tx.ledgerAccount.create({data:{organizationId:org,code:`STAFF_WALLET_${employee.id.replaceAll("-","").toUpperCase()}`,name:"Dedicated linked wallet",accountType:"STAFF_WALLET",normalSide:"DEBIT"}});
    const link=await tx.teamWallet.create({data:{organizationId:org,personId:employee.id,ledgerAccountId:wallet.id,createdBy:user.id}});
    if(scopedWallet){
      const walletRole=await tx.role.create({data:{organizationId:org,key:"dedicated_scoped_wallet",name:"Dedicated scoped wallet authority"}});
      const walletPermissions=await tx.permission.findMany({where:{organizationId:org,key:{in:["wallet:view","wallet:pay","wallet:void"]}}});expect(walletPermissions).toHaveLength(3);
      await tx.rolePermission.createMany({data:walletPermissions.map(permission=>({organizationId:org,roleId:walletRole.id,permissionId:permission.id}))});
      await tx.roleAssignment.create({data:{organizationId:org,roleId:walletRole.id,userAccountId:user.id,personId:person.id,scopeType:"wallet",scopeId:link.id,validFrom:new Date("2020-01-01")}});
    }
    return{org,person,user,employee,role,grant,bank,otherBank,wallet,link,input:{fromAccountId:bank.id,toAccountId:wallet.id,kind:"ADVANCE" as const,amount:"1500",currency:"MAD",purpose:"Dedicated employee working advance",reason:"Dedicated authorized wallet advance",idempotencyKey:randomUUID()}};
  });
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function actor(f:Fixture){return{organizationId:f.org,actorId:f.user.id,authContext:{...await authContextForAccount(f.org,f.user.id,{db}),personId:f.person.id}}}
describe("native financial transfers on real PostgreSQL",()=>{
  beforeAll(async()=>{
    if(!url||!["localhost","127.0.0.1"].includes(new URL(url).hostname))throw Error("Local PostgreSQL required");
    execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});
    admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});
  });
  afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect()});
  it("concurrent normalized retries add one bank-to-wallet advance and one audit",async()=>{
    const f=await fixture(),ctx=await actor(f),result=await Promise.all(Array.from({length:8},(_,index)=>postFinancialTransfer(ctx,{...f.input,amount:index%2?"1500.00":"1500",idempotencyKey:index%2?f.input.idempotencyKey.toUpperCase():f.input.idempotencyKey},{db})));
    expect(new Set(result.map(row=>row.id)).size).toBe(1);expect(result.filter(row=>!row.idempotent)).toHaveLength(1);
    await withTenant(db,f.org,async tx=>{const rows=await tx.posting.findMany();expect(rows).toHaveLength(2);expect(rows.find(row=>row.ledgerAccountId===f.wallet.id)).toMatchObject({side:"DEBIT",bucket:"ADVANCE",currency:"MAD"});expect(rows.every(row=>row.amount.toString()==="1500")).toBe(true);expect(await tx.auditLog.count({where:{action:"finance.transfer.posted"}})).toBe(1)});
  });
  it("changed retry facts or reasons cannot reuse the original request identity",async()=>{
    const f=await fixture(),ctx=await actor(f);await postFinancialTransfer(ctx,f.input,{db});
    for(const changed of[{amount:"1501"},{reason:"Different financial intent"},{purpose:"Different stated purpose"},{toAccountId:f.otherBank.id,kind:"TRANSFER"}])await expect(postFinancialTransfer(ctx,{...f.input,...changed},{db})).rejects.toBeInstanceOf(FinancialTransferConflictError);
    expect((await listFinancialTransfers(ctx,{}, {db})).rows).toHaveLength(1);
  });
  it("requires independent caller and current stored wallet read authority for transfer history",async()=>{
    const f=await fixture(true),ctx=await actor(f),advance=await postFinancialTransfer(ctx,f.input,{db});
    const bank=await postFinancialTransfer(ctx,{...f.input,toAccountId:f.otherBank.id,kind:"TRANSFER",idempotencyKey:randomUUID(),purpose:"Dedicated visible bank movement"},{db});
    expect(new Set((await listFinancialTransfers(ctx,{}, {db})).rows.map(row=>row.id))).toEqual(new Set([advance.id,bank.id]));
    const withoutWallet={...ctx,authContext:{...ctx.authContext,permissions:new Set([...ctx.authContext.permissions].filter(key=>key!=="wallet:view")),
      assignments:ctx.authContext.assignments?.map(assignment=>({...assignment,permissions:new Set([...assignment.permissions].filter(key=>key!=="wallet:view"))}))}};
    expect((await listFinancialTransfers(withoutWallet,{}, {db})).rows.map(row=>row.id)).toEqual([bank.id]);
    await withTenant(db,f.org,tx=>tx.roleAssignment.updateMany({where:{scopeType:"wallet",scopeId:f.link.id},data:{validTo:new Date("2020-01-02")}}));
    const current=await listFinancialTransfers(ctx,{}, {db});expect(current.rows.map(row=>row.id)).toEqual([bank.id]);
    expect(JSON.stringify(current)).not.toContain(f.wallet.id);expect(JSON.stringify(current)).not.toContain(f.wallet.name);
    expect(await withTenant(db,f.org,tx=>tx.financialTransaction.count())).toBe(2);
  });
  it("finds authorized transfer history beyond a full page of independently denied wallets",async()=>{
    const f=await fixture(true),ctx=await actor(f);
    for(let index=0;index<53;index++)await postFinancialTransfer(ctx,{...f.input,idempotencyKey:randomUUID(),purpose:`Dedicated private wallet advance ${index}`},{db});
    const bank=await postFinancialTransfer(ctx,{...f.input,toAccountId:f.otherBank.id,kind:"TRANSFER",idempotencyKey:randomUUID(),purpose:"Dedicated bank transfer beyond private wallet page"},{db});
    await withTenant(db,f.org,tx=>tx.roleAssignment.updateMany({where:{scopeType:"wallet",scopeId:f.link.id},data:{validTo:new Date("2020-01-02")}}));
    const result=await listFinancialTransfers(ctx,{}, {db});expect(result.rows.map(row=>row.id)).toEqual([bank.id]);expect(result.next).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(f.wallet.id);expect(JSON.stringify(result)).not.toContain(f.wallet.name);
  });
  it("returns custody to the bank and adds one reasoned exact reversal on concurrent retries",async()=>{
    const f=await fixture(),ctx=await actor(f),advance=await postFinancialTransfer(ctx,f.input,{db});
    const returned=await postFinancialTransfer(ctx,{...f.input,fromAccountId:f.wallet.id,toAccountId:f.bank.id,kind:"RETURN",amount:"450",purpose:"Dedicated remaining advance return",idempotencyKey:randomUUID()},{db});
    const undo={id:returned.id,reason:"Dedicated return recorded in error"},results=await Promise.all(Array.from({length:5},()=>voidFinancialTransfer(ctx,undo,{db})));
    expect(new Set(results.map(row=>row.reversalTransactionId)).size).toBe(1);
    await expect(voidFinancialTransfer(ctx,{...undo,reason:"Changed reversal reason"},{db})).rejects.toBeInstanceOf(FinancialTransferConflictError);
    await withTenant(db,f.org,async tx=>{const original=await tx.financialTransaction.findUniqueOrThrow({where:{id:advance.id}});expect(original.description).toBe(f.input.purpose);const lines=await tx.posting.findMany({where:{ledgerAccountId:f.wallet.id}});expect(lines).toHaveLength(3);expect(lines.reduce((total,row)=>row.side==="DEBIT"?total.add(Money.of(row.amount.toString(),row.currency)):total.subtract(Money.of(row.amount.toString(),row.currency)),Money.zero("MAD")).amount.toString()).toBe("1500");expect(await tx.auditLog.count({where:{action:"finance.transfer.reversed"}})).toBe(1)});
  });
  it("denies expired stored authority and restricted caller scopes without financial writes",async()=>{
    const f=await fixture(),ctx=await actor(f);
    await expect(postFinancialTransfer({...ctx,authContext:{...ctx.authContext,assignments:[],permissions:new Set(),scopes:[]}},f.input,{db})).rejects.toBeInstanceOf(FinancialTransferAccessError);
    await withTenant(db,f.org,tx=>tx.roleAssignment.update({where:{id:f.grant.id},data:{validTo:new Date("2020-01-02")}}));
    await expect(postFinancialTransfer(ctx,f.input,{db})).rejects.toBeInstanceOf(FinancialTransferAccessError);
    expect(await withTenant(db,f.org,tx=>tx.financialTransaction.count())).toBe(0);
  });
  it("denies foreign accounts, claims, cash custody, orphan wallets and mismatched movement kinds",async()=>{
    const f=await fixture(),other=await fixture(),ctx=await actor(f);
    await expect(postFinancialTransfer(ctx,{...f.input,toAccountId:other.wallet.id},{db})).rejects.toBeInstanceOf(FinancialTransferAccessError);
    await expect(postFinancialTransfer(ctx,{...f.input,toAccountId:f.otherBank.id},{db})).rejects.toBeInstanceOf(FinancialTransferConfigurationError);
    const invalid=await withTenant(db,f.org,async tx=>{
      const specs=[{code:"OWNER_PAYABLE",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"},{code:`CASH_CUSTODY_${f.employee.id.replaceAll("-","").toUpperCase()}`,accountType:"ASSET_LOCATION",normalSide:"DEBIT"},{code:"DEDICATED_ORPHAN_WALLET",accountType:"STAFF_WALLET",normalSide:"DEBIT"}];
      return Promise.all(specs.map(row=>tx.ledgerAccount.create({data:{organizationId:f.org,name:"Dedicated forbidden transfer account",...row}})));
    });
    for(const account of invalid)await expect(postFinancialTransfer(ctx,{...f.input,toAccountId:account.id},{db})).rejects.toBeInstanceOf(FinancialTransferConfigurationError);
    expect(await withTenant(db,f.org,tx=>tx.financialTransaction.count())).toBe(0);
  });
  it("requires the database transfer guard even for otherwise balanced audited raw writes",async()=>{
    const f=await fixture(),ctx=await actor(f),input={...f.input,toAccountId:f.otherBank.id};
    await expect(withTenant(db,f.org,async tx=>{
      const finance=new FinanceRepository(tx,f.org),clock=await finance.clock(),row=await finance.createFinancialTransaction({reference:`TRANSFER:${input.idempotencyKey}`,occurredAt:clock,description:input.purpose,idempotencyKey:`transfer:${input.idempotencyKey}`,createdBy:ctx.actorId,postings:financialTransferPostings(input)});
      await writeAuditEvent(tx,{organizationId:f.org,actorId:ctx.actorId,action:"finance.transfer.posted",resourceType:"financial_transaction",resourceId:row.id,after:input,reason:input.reason,requestId:randomUUID(),occurredAt:clock});
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");throw Error("Roll back an unexpectedly permitted mismatched transfer");
    })).rejects.toThrow(/financial transfer/iu);
    expect(await withTenant(db,f.org,tx=>tx.financialTransaction.count())).toBe(0);
  });
  it("finds the permitted wallet beyond 500 denied predecessors without publishing their accounts",async()=>{
    const f=await fixture(true),ctx=await actor(f),rows=Array.from({length:500},()=>({personId:randomUUID(),id:`00000000-${randomUUID().slice(9)}`}));
    await withTenant(db,f.org,async tx=>{
      await tx.person.createMany({data:rows.map(row=>({id:row.personId,organizationId:f.org,displayName:"Dedicated denied wallet employee"}))});
      await tx.ledgerAccount.createMany({data:rows.map(row=>({id:row.id,organizationId:f.org,code:`DENIED_WALLET_${row.id.replaceAll("-","").toUpperCase()}`,name:"Dedicated denied wallet account",accountType:"STAFF_WALLET",normalSide:"DEBIT"}))});
      await tx.teamWallet.createMany({data:rows.map(row=>({organizationId:f.org,personId:row.personId,ledgerAccountId:row.id,createdBy:f.user.id}))});
    });
    const result=await getFinancialTransferEditor(ctx,{}, {db});
    expect(new Set(result.accounts.map(row=>row.id))).toEqual(new Set([f.bank.id,f.otherBank.id,f.wallet.id]));expect(result.next).toBeUndefined();
    await expect(getFinancialTransferEditor(ctx,{from:rows[0].id},{db})).rejects.toBeInstanceOf(FinancialTransferAccessError);
  });
  it("pages authorized locations and retains a selected account beyond the current page",async()=>{
    const f=await fixture(),ctx=await actor(f),ids=Array.from({length:55},()=>`00000000-${randomUUID().slice(9)}`);
    await withTenant(db,f.org,tx=>tx.ledgerAccount.createMany({data:ids.map((id,index)=>({id,organizationId:f.org,code:`DEDICATED_LOCATION_${index}`,name:`Dedicated location ${index}`,accountType:"ASSET_LOCATION",normalSide:"DEBIT"}))}));
    const first=await getFinancialTransferEditor(ctx,{}, {db});expect(first.accounts).toHaveLength(50);expect(first.next).toBe(first.accounts.at(-1)?.id);
    const second=await getFinancialTransferEditor(ctx,{after:first.next},{db});expect(second.accounts).toHaveLength(8);expect(second.next).toBeUndefined();
    expect(new Set([...first.accounts,...second.accounts].map(row=>row.id)).size).toBe(58);
    const selected=await getFinancialTransferEditor(ctx,{from:f.wallet.id},{db});expect(selected.accounts).toHaveLength(51);expect(selected.accounts.some(row=>row.id===f.wallet.id)).toBe(true);
  });
});
