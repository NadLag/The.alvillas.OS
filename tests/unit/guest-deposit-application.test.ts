import {randomUUID} from "node:crypto";
import {describe,expect,it} from "vitest";
import fc from "fast-check";
import {Money} from "@/platform/money/money";
import {guestDepositPolicySchema} from "@/platform/config/guest-deposit-policy";
import {guestDepositApplicationPostings} from "@/modules/finance/domain/guest-deposit-application";
import {GuestDepositConfigurationError,GuestDepositConflictError,GuestDepositSourceError} from "@/modules/finance/domain/guest-deposit";
const labels={en:"Accommodation",fr:"Hébergement",ar:"الإقامة"},kind={key:"stay",labels,liability_account_code:"GUEST_PREPAYMENT",application:"ACCOMMODATION_PREPAYMENT"as const};
const policy=guestDepositPolicySchema.parse({source:"ACTUAL_GUEST_RECEIPT",kinds:[kind],receipt_account_codes:["BANK_A"],refund_account_codes:["BANK_B"],receipt_bucket:"GUEST_DEPOSIT_RECEIPT",refund_bucket:"GUEST_DEPOSIT_REFUND",payment_methods:[{key:"bank_transfer",labels}],refund_limit:"ORIGINAL_UNAPPLIED_UNREFUNDED_LIABILITY",closed_period:"REJECT",correction_date:"CURRENT_OPEN_PERIOD",application:{source:"POSTED_ACCOMMODATION_RECEIVABLE",recognition:"ORIGINAL_BOOKING_ACCRUAL_EVENT",receivable_account_code:"GUEST_ACCOMMODATION_RECEIVABLE",bucket:"GUEST_DEPOSIT_APPLICATION"}});
const source={organizationId:randomUUID(),depositId:randomUUID(),reservationId:randomUUID(),propertyId:randomUUID(),guestId:randomUUID(),kind:"stay"},liability={id:randomUUID(),code:"GUEST_PREPAYMENT",accountType:"CLAIM_OWNERSHIP",normalSide:"CREDIT",archivedAt:null},receivable={id:randomUUID(),code:"GUEST_ACCOMMODATION_RECEIVABLE",accountType:"CLAIM_OWNERSHIP",normalSide:"DEBIT",archivedAt:null};
function input(amount="8000",outstanding=amount,receivableOutstanding=amount){return{source,kind,liability,receivable,amount:Money.of(amount,"MAD"),outstanding:Money.of(outstanding,"MAD"),receivableOutstanding:Money.of(receivableOutstanding,"MAD"),applicationId:randomUUID(),originalTransactionId:randomUUID(),receivableAssignmentId:randomUUID(),receivablePostingId:randomUUID(),policy};}
const cents=(value:bigint)=>Money.of(`${value/100n}.${(value%100n).toString().padStart(2,"0")}`,"MAD");
describe("actual original deposit application to an accommodation receivable",()=>{
 it("applies the handbook's8000 without receiving money or creating accommodation revenue a second time",()=>{
  const value=input(),rows=guestDepositApplicationPostings(value);expect(rows.map(row=>({account:row.ledgerAccountId,side:row.side,amount:row.amount.toJSON()}))).toEqual([{account:liability.id,side:"DEBIT",amount:{amount:"8000.00",currency:"MAD"}},{account:receivable.id,side:"CREDIT",amount:{amount:"8000.00",currency:"MAD"}}]);expect(rows.every(row=>row.dimensions.deposit_id===source.depositId&&row.dimensions.receivable_assignment_id===value.receivableAssignmentId&&row.dimensions.receivable_posting_id===value.receivablePostingId)).toBe(true);expect(rows.some(row=>row.bucket==="OWNER_REVENUE"||row.bucket==="COMMISSION")).toBe(false);
 });
 it("retains exact cents over multiple partial applications with separate original guest and receivable limits",()=>{
  let remaining=Money.of("0.07","MAD"),due=Money.of("0.08","MAD");for(const amount of["0.01","0.02","0.04"]){const value={...input(amount),outstanding:remaining,receivableOutstanding:due},rows=guestDepositApplicationPostings(value);remaining=remaining.subtract(rows[0].amount);due=due.subtract(rows[1].amount);}expect(remaining.toJSON().amount).toBe("0.00");expect(due.toJSON().amount).toBe("0.01");expect(()=>guestDepositApplicationPostings({...input("0.01"),outstanding:remaining,receivableOutstanding:due})).toThrow(GuestDepositConflictError);
 });
 it("cannot borrow another guest's funds or over-apply a paid receivable",()=>{
  for(const value of[input("0.08","0.07","1000"),input("0.08","1000","0.07"),{...input("0.01"),outstanding:Money.of("0.01","EUR")}])expect(()=>guestDepositApplicationPostings(value)).toThrow(GuestDepositConflictError);
 });
 it("keeps refundable security funds separate and fails closed when treatment or the original claim route is unavailable",()=>{
  expect(()=>guestDepositApplicationPostings({...input(),kind:{...kind,application:"REFUND_ONLY"}})).toThrow(GuestDepositSourceError);const{application,...original}=policy;void application;expect(()=>guestDepositApplicationPostings({...input(),policy:original})).toThrow(GuestDepositConfigurationError);for(const account of[{...receivable,accountType:"ASSET_LOCATION"},{...receivable,normalSide:"CREDIT"},{...receivable,code:"ANOTHER_CLAIM"},{...receivable,archivedAt:new Date()}])expect(()=>guestDepositApplicationPostings({...input(),receivable:account})).toThrow(GuestDepositSourceError);
 });
 it("balances every exact application and derives both remaining amounts without floats or stored balances",()=>{
  fc.assert(fc.property(fc.bigInt({min:1n,max:999999999999999999n}),fc.bigInt({min:1n,max:999999999999999999n}),(received,due)=>{const applied=received<due?received:due,value={...input(),amount:cents(applied),outstanding:cents(received),receivableOutstanding:cents(due)},rows=guestDepositApplicationPostings(value);expect(rows[0].amount.equals(rows[1].amount)).toBe(true);expect(value.outstanding.subtract(rows[0].amount).toJSON().amount).toBe(cents(received-applied).toJSON().amount);expect(value.receivableOutstanding.subtract(rows[1].amount).toJSON().amount).toBe(cents(due-applied).toJSON().amount);expect(rows[0].amount.amount.gt(0)).toBe(true);}));
 });
});
