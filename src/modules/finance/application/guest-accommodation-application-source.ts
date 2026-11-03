import {z} from "zod";
import type {TenantTransaction} from "@/platform/db/tenant";
import {Money} from "@/platform/money/money";
import {commandFingerprint} from "@/platform/http/command-fingerprint";
import {calendarDateAt} from "@/i18n/format";
import {FinanceRepository} from "../infrastructure/finance-repository";
import {AccountingPeriodRepository} from "../infrastructure/accounting-period-repository";
import {GuestAccommodationApplicationRepository} from "../infrastructure/guest-accommodation-application-repository";
import type {guestDepositFundedApplicationReviewInput} from "../domain/guest-deposit-command";
import {guestDepositApplicationVectorDelta} from "../domain/guest-deposit-application-vector";
import {GuestDepositAuthorizationError,GuestDepositConfigurationError,GuestDepositConflictError,GuestDepositSourceError} from "../domain/guest-deposit";
import type {FinancePostingDraft} from "../domain/reservation-revenue";
import {recheckFinanceAuthorization,type FinanceActorContext} from "./finance-access";
import {readGuestDepositSourceInTransaction,resolveGuestDepositPolicyInTransaction} from "./guest-deposit-service";
import {buildReservationRevenueAllocationsInTransaction,buildReservationRevenuePostings,buildReservationCommissionPostings} from "./reservation-revenue-service";

type Draft=z.infer<typeof guestDepositFundedApplicationReviewInput>;
const confirmationSchema=z.object({id:z.uuid(),reference:z.string().min(1),propertyId:z.uuid(),source:z.string().min(1)}).passthrough();
const checkoutSchema=z.object({id:z.uuid(),propertyId:z.uuid(),status:z.literal("CHECKED_OUT")}).passthrough();
const metadata=z.record(z.string(),z.json());

/** Compose the existing native allocation and posting factories for an already authorized source. */
export async function buildGuestAccommodationNativeTarget(finance:FinanceRepository,reservation:NonNullable<Awaited<ReturnType<FinanceRepository["findReservation"]>>>,gross:Money,actorId:string,accounts:{guest:string;owner:string;company:string}){
 const allocations=await buildReservationRevenueAllocationsInTransaction({repository:finance,reservation,grossAmount:gross,actorId}),commission=allocations.reduce((sum,row)=>sum.add(row.commissionAmount),Money.zero(gross.currency));
 return{allocations,commission,rows:[...buildReservationRevenuePostings({receivedAccountId:accounts.guest,ownerPayableAccountId:accounts.owner,grossAmount:gross,reservation,allocations}),...buildReservationCommissionPostings({ownerPayableAccountId:accounts.owner,commissionRevenueAccountId:accounts.company,commissionTotal:commission,reservation,allocations})]};
}

/** Review and admission share real checkout evidence, original native ownership and derived movement caps. */
export async function inspectGuestAccommodationApplication(ctx:FinanceActorContext,input:Draft,tx:TenantTransaction){
 const source=await readGuestDepositSourceInTransaction(ctx,input.depositId,tx),finance=new FinanceRepository(tx,ctx.organizationId),repository=new GuestAccommodationApplicationRepository(tx,ctx.organizationId),periods=new AccountingPeriodRepository(tx,ctx.organizationId),now=await finance.clock(),amount=Money.of(input.amount,input.currency),kind=source.snapshot.policy.value.kinds.find(row=>row.key===source.snapshot.source.kind);
 if(source.row.reversedByTransactions.length||!kind||kind.application!=="ACCOMMODATION_PREPAYMENT"||source.liability.archivedAt||source.amount.currency!==amount.currency)throw new GuestDepositSourceError();
 const target={...source.resource,id:undefined,financialRecordId:undefined,amount:amount.toJSON().amount,occurredAt:now},checks:Array<Parameters<typeof recheckFinanceAuthorization>[3][number]>=[...source.checks,{action:"pay",resource:source.resource},{action:"view",resource:target},{action:"create",resource:target},{action:"pay",resource:target}];
 await recheckFinanceAuthorization(ctx,tx,now,checks,new GuestDepositAuthorizationError());
 const policy=await resolveGuestDepositPolicyInTransaction(tx,ctx.organizationId,source.snapshot.source.propertyId,now,source.snapshot.source.reservationId);if(policy.value.application?.source!=="ORIGINAL_GUEST_PREPAYMENT")throw new GuestDepositConfigurationError();
 const facts=await repository.source(source.snapshot.source.reservationId),native=await finance.findReservation(source.snapshot.source.reservationId),baseCurrency=await finance.findOrganizationBaseCurrency();
 if(!facts||!native||facts.reservation.guestId!==source.snapshot.source.guestId||facts.reservation.propertyId!==source.snapshot.source.propertyId||facts.reservation.property.archivedAt||!["CHECKED_OUT","FINANCIAL_RECONCILIATION","CLOSED"].includes(facts.reservation.status)||!facts.confirmation||!facts.checkout||facts.confirmation.createdAt>now||facts.checkout.createdAt>now||facts.confirmation.version>facts.checkout.version||facts.checkout.version>facts.reservation.version||facts.financialSnapshot.version>facts.reservation.version)throw new GuestDepositSourceError();
 const confirmation=confirmationSchema.safeParse(facts.confirmation.after),checkout=checkoutSchema.safeParse(facts.checkout.after);
 if(!confirmation.success||!checkout.success||confirmation.data.id!==native.id||checkout.data.id!==native.id||confirmation.data.propertyId!==native.propertyId||checkout.data.propertyId!==native.propertyId)throw new GuestDepositSourceError();
 if(facts.financialSnapshot.amount===null||facts.financialSnapshot.currency!==amount.currency||amount.currency!==baseCurrency||facts.commissions.length!==native.owners.length||!native.owners.length)throw new GuestDepositConfigurationError();
 for(const owner of native.owners){const original=facts.commissions.find(row=>row.ownerId===owner.ownerId);if(!original||original.propertyId!==native.propertyId||original.shareBps!==owner.shareBps||original.commissionBasis!=="GROSS_ACCOMMODATION"||original.accrualEvent!=="ON_CHECKOUT")throw new GuestDepositConfigurationError();checks.push({action:"view",resource:{...target,ownerId:owner.ownerId}},{action:"pay",resource:{...target,ownerId:owner.ownerId}},{action:"create",resource:{...target,ownerId:owner.ownerId}});}
 await recheckFinanceAuthorization(ctx,tx,await finance.clock(),checks,new GuestDepositAuthorizationError());
 await periods.assertPostingOpen(now);await periods.assertPostingOpen(facts.checkout.createdAt);const calendar=await periods.policy(now);if(!calendar)throw new GuestDepositConfigurationError();
 const legacy=await finance.findPostingTransactionsForReservation(native.id);if(legacy.some(row=>!row.reversedByTransactions.length&&row.postings.some(posting=>{const parsed=metadata.safeParse(posting.dimensions);return!parsed.success||parsed.data.source!=="GUEST_DEPOSIT"||parsed.data.application_source!=="ORIGINAL_GUEST_PREPAYMENT";})))throw new GuestDepositConflictError();
 const position=await repository.position(native.id,amount.currency),applied=Money.of(position.applied,amount.currency),quote=Money.of(facts.financialSnapshot.amount.toString(),amount.currency),remaining=quote.subtract(applied);
 if(applied.amount.lt(0)||!quote.amount.gt(0)||remaining.amount.lt(0)||amount.amount.gt(remaining.amount)||amount.amount.gt(source.outstanding.amount))throw new GuestDepositConflictError();
 const[ownerPayable,commissionRevenue]=await Promise.all([finance.ensureLedgerAccount({code:"OWNER_PAYABLE",name:"Owner payable",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT"}),finance.ensureLedgerAccount({code:"ALVILLAS_COMMISSION_REVENUE",name:"ALVILLAS commission revenue",accountType:"ALVILLAS_OWN",normalSide:"CREDIT"})]);
 if(ownerPayable.archivedAt||ownerPayable.accountType!=="CLAIM_OWNERSHIP"||ownerPayable.normalSide!=="CREDIT"||commissionRevenue.archivedAt||commissionRevenue.accountType!=="ALVILLAS_OWN"||commissionRevenue.normalSide!=="CREDIT")throw new GuestDepositSourceError();
 const reservation={...native,source:confirmation.data.source,reference:confirmation.data.reference};
 const targetVector=(gross:Money)=>buildGuestAccommodationNativeTarget(finance,reservation,gross,ctx.actorId,{guest:source.liability.id,owner:ownerPayable.id,company:commissionRevenue.id});
 const before=await targetVector(applied),after=await targetVector(applied.add(amount)),posted=await repository.ownerVector(native.id,amount.currency),actual=posted.flatMap(row=>{const debit=Money.of(row.debit,row.currency);return debit.amount.isZero()?[]:[{ledgerAccountId:row.ledgerAccountId,side:debit.amount.gt(0)?"DEBIT"as const:"CREDIT"as const,amount:Money.of(debit.amount.abs(),row.currency),bucket:row.bucket,dimensions:metadata.parse(row.dimensions)}];});
 const principal=before.rows.find(row=>row.ledgerAccountId===source.liability.id);if(!principal)throw new GuestDepositSourceError();const actualBefore:FinancePostingDraft[]=applied.amount.isZero()?actual:[principal,...actual];
 try{if(guestDepositApplicationVectorDelta(actualBefore,before.rows).length)throw new GuestDepositConflictError();}catch{throw new GuestDepositConflictError();}
 const postings=guestDepositApplicationVectorDelta(before.rows,after.rows),funding=postings.filter(row=>row.ledgerAccountId===source.liability.id);if(funding.length!==1||funding[0].side!=="DEBIT"||!funding[0].amount.equals(amount)||postings.some(row=>![source.liability.id,ownerPayable.id,commissionRevenue.id].includes(row.ledgerAccountId)))throw new GuestDepositSourceError();
 const fingerprint=commandFingerprint({input,source:source.snapshot,sourceMovements:source.movements,policy,facts,position,ownerPayable,commissionRevenue,before:before.rows,after:after.rows,calendar:{id:calendar.id,version:calendar.version,value:calendar.value},month:calendarDateAt(now,calendar.value.timezone).slice(0,7)});
 return{source,finance,repository,periods,now,amount,kind,target,checks,policy,facts,reservation,position,applied,quote,remaining,ownerPayable,commissionRevenue,before,after,postings,fingerprint};
}
