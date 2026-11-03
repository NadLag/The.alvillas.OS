import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {PrismaClient} from "@prisma/client";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {withTenant} from "@/platform/db/tenant";
import {authContextForAccount} from "@/platform/authz/account-context";
import {ConfigRuleRepository} from "@/platform/config/config-rule-repository";
import {FinanceRepository} from "@/modules/finance/infrastructure/finance-repository";
import {createManualReservation} from "@/modules/reservations/application/reservation-service";
import {changeReservation} from "@/modules/reservations/application/reservation-management-service";
import {reviewGuestDepositReceipt,postGuestDepositReceipt} from "@/modules/finance/application/guest-deposit-service";
import {inspectGuestAccommodationApplication} from "@/modules/finance/application/guest-accommodation-application-source";
import {applyGuestAccommodationDeposit,reviewGuestAccommodationApplication} from "@/modules/finance/application/guest-accommodation-application-service";
import {GuestDepositAuthorizationError,GuestDepositConflictError,GuestDepositSourceError} from "@/modules/finance/domain/guest-deposit";
import {Money} from "@/platform/money/money";
import {GuestDepositRepository} from "@/modules/finance/infrastructure/guest-deposit-repository";
import * as auditWriter from "@/platform/audit/audit-writer";
import {reviewGuestDepositRefund,postGuestDepositRefund} from "@/modules/finance/application/guest-deposit-service";
import {actualGuestDepositFixture} from "./support/guest-deposit-fixture";
import {provisionIntegrationRole} from "./support/database-role";

const url=process.env.TEST_DATABASE_URL;let admin:PrismaClient,db:PrismaClient;
beforeAll(async()=>{const target=url?new URL(url):null;if(!target||!["127.0.0.1","localhost"].includes(target.hostname)||!(target.pathname.startsWith("/alvillas_automation_")||process.env.GITHUB_ACTIONS==="true"&&target.pathname==="/alvillas_os"))throw Error("Dedicated accommodation application database required");execFileSync(process.execPath,["node_modules/prisma/build/index.js","migrate","deploy"],{env:{...process.env,DATABASE_URL:url},stdio:"pipe"});admin=new PrismaClient({datasourceUrl:url});await provisionIntegrationRole(admin,"alvillas_ops_tests");const scoped=new URL(url!);scoped.username="alvillas_ops_tests";scoped.password="alvillas_ops_tests";db=new PrismaClient({datasourceUrl:scoped.toString()});});
afterAll(async()=>{await db?.$disconnect();await admin?.$disconnect();});

async function fixture(checkout=true,kind="stay"){
 const f=await actualGuestDepositFixture(db,admin);
 await withTenant(db,f.org,async tx=>{
  const permissions=await tx.permission.findMany({where:{organizationId:f.org,key:{in:["reservation:view","reservation:edit"]}}});expect(permissions).toHaveLength(2);await tx.rolePermission.createMany({data:permissions.map(permission=>({organizationId:f.org,roleId:f.role.id,permissionId:permission.id})),skipDuplicates:true});
  await new ConfigRuleRepository(tx,f.org).createVersion({key:"finance.guest_deposits",scopeType:"organization",effectiveFrom:new Date("2020-01-01"),createdBy:f.account.id,value:{...f.policy,application:{source:"ORIGINAL_GUEST_PREPAYMENT",recognition:"ORIGINAL_BOOKING_ACCRUAL_EVENT",application_event:"ACTUAL_CHECKOUT",application_date:"CURRENT_OPEN_PERIOD",allocation:"CUMULATIVE_ORIGINAL_NATIVE_TARGET"}},reason:"Explicit funded accommodation application at actual checkout"});
 });
 f.ctx={...f.ctx,authContext:{...await authContextForAccount(f.org,f.account.id,{db}),personId:f.person.id}};
 const now=await withTenant(db,f.org,tx=>new FinanceRepository(tx,f.org).clock()),start=new Date(now.getTime()-3*86400000),booking=await createManualReservation(f.ctx,{propertyId:f.property.id,source:"DIRECT",guestName:"Actual checked out guest",guestEmail:"checkout@example.test",checkIn:start.toISOString().slice(0,10),checkOut:now.toISOString().slice(0,10),adultCount:1,childCount:0,quote:{amount:"8000.00",currency:"MAD"},idempotencyKey:randomUUID()},{db,requestId:randomUUID()});
 const receiptInput={...f.receiptInput,reservationId:booking.reservation.id,kind,receivedAt:(await withTenant(db,f.org,tx=>new FinanceRepository(tx,f.org).clock())).toISOString()},review=await reviewGuestDepositReceipt(f.ctx,receiptInput,{db}),receipt=await postGuestDepositReceipt(f.ctx,{...receiptInput,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID(),reason:"Fund only the actual original guest liability"},{db});
 let version=await withTenant(db,f.org,async tx=>(await tx.reservation.findFirstOrThrow({where:{organizationId:f.org,id:booking.reservation.id},select:{version:true}})).version);
 if(checkout)for(const status of ["GUEST_PREPARATION","CHECKED_IN","STAYING","CHECKED_OUT"]as const){const changed=await changeReservation(f.ctx,{reservationId:booking.reservation.id,expectedVersion:version,idempotencyKey:randomUUID(),reason:"Retain actual native stay transition evidence",operation:"TRANSITION",status},{db,requestId:randomUUID()});version=changed.version;}
 return{...f,booking,receipt};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const inspect=(f:Fixture,amount="0.07")=>withTenant(db,f.org,tx=>inspectGuestAccommodationApplication(f.ctx,{depositId:f.receipt.depositId,amount,currency:"MAD"},tx));
const journals=(f:Fixture)=>withTenant(db,f.org,tx=>tx.$queryRaw<Array<{id:string;xmin:string;body:unknown}>>`SELECT id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid ORDER BY id`);
const financial=(f:Fixture)=>withTenant(db,f.org,tx=>tx.$queryRaw<Array<{kind:string;id:string;xmin:string;body:unknown}>>`SELECT 'journal' AS kind,id::text,xmin::text,to_jsonb(t) AS body FROM financial_transaction t WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'posting',id::text,xmin::text,to_jsonb(p) FROM posting p WHERE organization_id=${f.org}::uuid UNION ALL SELECT 'audit',id::text,xmin::text,to_jsonb(a) FROM audit_log a WHERE organization_id=${f.org}::uuid ORDER BY kind,id`);
async function applicationCommand(f:Fixture,amount="0.07"){const input={depositId:f.receipt.depositId,amount,currency:"MAD"},review=await reviewGuestAccommodationApplication(f.ctx,input,{db});return{...input,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID(),reason:"Apply only actual original guest funds at checkout"};}

describe("actual checkout funded accommodation application evidence",()=>{
 it("posts the actual native funded vector once and preserves every original financial row",async()=>{
  const f=await fixture(),input=await applicationCommand(f),before=await journals(f),protectedBefore=await financial(f),created=await applyGuestAccommodationDeposit(f.ctx,input,{db});
  expect(created).toMatchObject({depositId:f.receipt.depositId,operation:"APPLY",idempotent:false});expect(await applyGuestAccommodationDeposit(f.ctx,input,{db})).toMatchObject({id:created.id,idempotent:true});
  const after=await journals(f),keys=new Set(before.map(row=>row.id));expect(after.filter(row=>keys.has(row.id))).toEqual(before);expect(after).toHaveLength(before.length+1);const protectedKeys=new Set(protectedBefore.map(row=>row.kind+":"+row.id));expect((await financial(f)).filter(row=>protectedKeys.has(row.kind+":"+row.id))).toEqual(protectedBefore);
 });
 it("conserves the native cumulative commission across seven actual one-cent applications",async()=>{
  const f=await fixture(),original=await financial(f);for(let index=0;index<7;index++)await applyGuestAccommodationDeposit(f.ctx,await applicationCommand(f,"0.01"),{db});
  const position=await withTenant(db,f.org,async tx=>{const source=await new GuestDepositRepository(tx,f.org).receipt(f.receipt.depositId);if(!source)throw Error("Actual source required");const claim=source.postings.find(row=>row.ledgerAccount.code==="GUEST_PREPAYMENT")!;return new GuestDepositRepository(tx,f.org).movements(f.receipt.depositId,claim.ledgerAccountId,"MAD");});expect([position.received,position.refunded,position.applied].map(value=>Money.of(value,"MAD").toJSON().amount)).toEqual(["0.07","0.00","0.07"]);
  const totals=await withTenant(db,f.org,tx=>tx.$queryRaw<Array<{code:string;amount:string}>>`SELECT a.code,sum(CASE p.side WHEN 'CREDIT' THEN p.amount ELSE -p.amount END)::text AS amount FROM posting p JOIN ledger_account a ON a.organization_id=p.organization_id AND a.id=p.ledger_account_id WHERE p.organization_id=${f.org}::uuid AND p.dimensions->>'reservation_id'=${f.booking.reservation.id} AND p.dimensions->>'application_source'='ORIGINAL_GUEST_PREPAYMENT' GROUP BY a.code ORDER BY a.code`);expect(totals.map(row=>({code:row.code,amount:Money.of(row.amount,"MAD").toJSON().amount}))).toEqual([{code:"ALVILLAS_COMMISSION_REVENUE",amount:"0.01"},{code:"GUEST_PREPAYMENT",amount:"-0.07"},{code:"OWNER_PAYABLE",amount:"0.06"}]);const keys=new Set(original.map(row=>row.kind+":"+row.id));expect((await financial(f)).filter(row=>keys.has(row.kind+":"+row.id))).toEqual(original);
 });
 it("admits one journal for concurrent exact replay and rejects changed original command intent",async()=>{
  const f=await fixture(),input=await applicationCommand(f,"0.03"),results=await Promise.all([applyGuestAccommodationDeposit(f.ctx,input,{db}),applyGuestAccommodationDeposit(f.ctx,input,{db})]);expect(new Set(results.map(row=>row.id)).size).toBe(1);expect(results.map(row=>row.idempotent).sort()).toEqual([false,true]);await expect(applyGuestAccommodationDeposit(f.ctx,{...input,amount:"0.04"},{db})).rejects.toBeInstanceOf(GuestDepositConflictError);
 });
 it("serializes application against competing refunds of the same original funds",async()=>{
  const f=await fixture(),application=await applicationCommand(f,"0.05"),refundDraft={depositId:f.receipt.depositId,accountId:f.banks.refund.id,amount:"0.05",currency:"MAD",method:"bank_transfer",externalReference:null,purpose:"Return only actual unearned original guest funds"},review=await reviewGuestDepositRefund(f.ctx,refundDraft,{db}),refund={...refundDraft,reviewFingerprint:review.reviewFingerprint,idempotencyKey:randomUUID(),reason:"Protect the same original source budget during application"},results=await Promise.allSettled([applyGuestAccommodationDeposit(f.ctx,application,{db}),postGuestDepositRefund(f.ctx,refund,{db})]);expect(results.filter(row=>row.status==="fulfilled")).toHaveLength(1);expect(results.filter(row=>row.status==="rejected")).toHaveLength(1);const failure=results.find(row=>row.status==="rejected");expect(failure?.status==="rejected"&&failure.reason instanceof GuestDepositConflictError).toBe(true);
 });
 it("rejects a balanced forged commission at PostgreSQL admission without trusting the application vector",async()=>{
  const f=await fixture(),input=await applicationCommand(f),before=await financial(f),native=Reflect.get<FinanceRepository,"createFinancialTransaction">(FinanceRepository.prototype,"createFinancialTransaction"),spy=vi.spyOn(FinanceRepository.prototype,"createFinancialTransaction").mockImplementation(function(this:FinanceRepository,command){return native.call(this,command.reference.startsWith("GUEST_DEPOSIT_APPLICATION:")?{...command,postings:command.postings.map(row=>row.bucket==="COMMISSION"?{...row,amount:row.amount.add(Money.of("0.01",row.amount.currency))}:row)}:command);});
  try{await expect(applyGuestAccommodationDeposit(f.ctx,input,{db})).rejects.toThrow(/guest_application_exact_native_target_delta_required/u);}finally{spy.mockRestore();}expect(await financial(f)).toEqual(before);
 });
 it("requires the actual same-transaction application audit at PostgreSQL admission",async()=>{
  const f=await fixture(),input=await applicationCommand(f),before=await financial(f),native=auditWriter.writeAuditEvent,spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{if(event.action==="finance.guest_deposit.applied")return;return native(tx,event);});try{await expect(applyGuestAccommodationDeposit(f.ctx,input,{db})).rejects.toThrow(/guest_application_atomic_audit_required/u);}finally{spy.mockRestore();}expect(await financial(f)).toEqual(before);
 });
 it.each(["nativeBefore","nativeAfter","originalOwnerOrder"]as const)("rejects forged retained %s at the SQL boundary",async field=>{
  const f=await fixture(),input=await applicationCommand(f),before=await financial(f),native=auditWriter.writeAuditEvent,spy=vi.spyOn(auditWriter,"writeAuditEvent").mockImplementation(async(tx,event)=>{if(event.action!=="finance.guest_deposit.applied")return native(tx,event);const after=JSON.parse(JSON.stringify(event.after))as Record<string,unknown>;after[field]=field==="nativeBefore"?after.nativeAfter:[];return native(tx,{...event,after});});try{await expect(applyGuestAccommodationDeposit(f.ctx,input,{db})).rejects.toThrow(/guest_application_retained_(native_target_snapshot|original_owner_order)_required/u);}finally{spy.mockRestore();}expect(await financial(f)).toEqual(before);
 });
 it("reviews only original funds using frozen native owners and commission, without creating quote-sized debt or moving cash",async()=>{
  const f=await fixture(),before=await journals(f),prepared=await inspect(f);
  expect(prepared.facts.checkout?.after).toMatchObject({status:"CHECKED_OUT"});expect(prepared.quote.toJSON()).toEqual({amount:"8000.00",currency:"MAD"});expect(prepared.applied.toJSON().amount).toBe("0.00");
  expect(prepared.postings.map(row=>({account:row.ledgerAccountId,side:row.side,amount:row.amount.toJSON().amount}))).toEqual(expect.arrayContaining([{account:prepared.source.liability.id,side:"DEBIT",amount:"0.07"},{account:prepared.commissionRevenue.id,side:"CREDIT",amount:"0.01"}]));
  expect(prepared.after.allocations.map(row=>({gross:row.grossAmount.toJSON().amount,commission:row.commissionAmount.toJSON().amount,net:row.netAmount.toJSON().amount}))).toEqual([{gross:"0.07",commission:"0.01",net:"0.06"}]);expect(prepared.postings.some(row=>[f.banks.receipt.id,f.banks.refund.id].includes(row.ledgerAccountId))).toBe(false);expect(await journals(f)).toEqual(before);
 });
 it("rejects recognition before an actual native checkout",async()=>{const f=await fixture(false),before=await journals(f);await expect(inspect(f)).rejects.toBeInstanceOf(GuestDepositSourceError);expect(await journals(f)).toEqual(before);});
 it("keeps security deposits refundable and refuses their accommodation application",async()=>{const f=await fixture(true,"security"),before=await journals(f);await expect(inspect(f)).rejects.toBeInstanceOf(GuestDepositSourceError);expect(await journals(f)).toEqual(before);});
 it("caps partial application at original unapplied funds rather than the quote or pooled bank balance",async()=>{const f=await fixture(),before=await journals(f);await expect(inspect(f,"0.08")).rejects.toBeInstanceOf(GuestDepositConflictError);expect(await journals(f)).toEqual(before);});
 it("requires current independent financial payment authority for native owner recognition",async()=>{const f=await fixture(),before=await journals(f);await withTenant(db,f.org,tx=>tx.rolePermission.deleteMany({where:{organizationId:f.org,roleId:f.role.id,permission:{key:"financial_transaction:pay"}}}));await expect(inspect(f)).rejects.toBeInstanceOf(GuestDepositAuthorizationError);expect(await journals(f)).toEqual(before);});
});
