import { randomUUID } from "node:crypto";
import { describe,expect,it } from "vitest";
import { financialTransferSchema } from "@/modules/finance/domain/financial-transfer";
import { approvalThresholdsConfigSchema } from "@/platform/config/rule-registry";
import { evaluateConfiguredApproval } from "@/modules/finance/domain/configured-finance-rules";
import { Money } from "@/platform/money/money";
const transfer={fromAccountId:randomUUID(),toAccountId:randomUUID(),kind:"TRANSFER",currency:"MAD",purpose:"Actual physical money transfer",reason:"Retain validation before any financial write",idempotencyKey:randomUUID()};
describe("financial input rejection before monetary evaluation",()=>{
  it.each(["invalid","1,00","١٢٫٣٤",""])("returns a validation result for malformed transfer money %s instead of throwing from Decimal",amount=>{
    let success:boolean|undefined;expect(()=>{success=financialTransferSchema.safeParse({...transfer,amount}).success;}).not.toThrow();expect(success).toBe(false);
  });
  it.each(["0","750.00","9999999999999999.99"])("rejects an amount-based approval threshold without its explicit currency: %s",amount=>{
    const config={thresholds:[{key:"actual_cost_review",amount,requires_approval_from:["finance"]}]};
    expect(approvalThresholdsConfigSchema.safeParse(config).success).toBe(false);
    expect(()=>evaluateConfiguredApproval(config,{amount:Money.of("1000.00","MAD"),category:"staff"})).toThrow();
  });
  it.each(["0.01","500.25","1000","9999999999999999.99"])("preserves exact permitted transfer money %s",amount=>{
    expect(financialTransferSchema.parse({...transfer,amount}).amount).toBe(Money.of(amount,"MAD").toJSON().amount);
  });
  it.each(["0","-0.01","0.001","01.00","1e3","Infinity"])("keeps transfer range and precision rejection for %s",amount=>{
    expect(financialTransferSchema.safeParse({...transfer,amount}).success).toBe(false);
  });
  it("keeps monetary currency matching and configured approval steps unchanged",()=>{
    const config={thresholds:[{key:"actual_cost_review",amount:"750.00",currency:"MAD",requires_approval_from:["finance"]}]};
    expect(evaluateConfiguredApproval(config,{amount:Money.of("1000.00","MAD"),category:"staff"}).requiredSteps).toEqual(["finance"]);
    expect(evaluateConfiguredApproval(config,{amount:Money.of("1000.00","EUR"),category:"staff"}).requiredSteps).toEqual([]);
  });
  it("keeps non-monetary unconditional and percentage review rules valid without an amount currency",()=>{
    const unconditional={thresholds:[{key:"actual_cost_review",requires_approval_from:["owner"]}]};
    expect(evaluateConfiguredApproval(unconditional,{amount:Money.of("1000.00","MAD"),category:"staff"}).requiredSteps).toEqual(["owner"]);
    const relative={thresholds:[{key:"actual_cost_review",percentage_of_revenue_bps:5000,requires_approval_from:["finance"]}]};
    expect(evaluateConfiguredApproval(relative,{amount:Money.of("1000.00","MAD"),periodRevenue:Money.of("2000.00","MAD"),category:"staff"}).requiredSteps).toEqual(["finance"]);
  });
});
