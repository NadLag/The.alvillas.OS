import { describe,expect,it } from "vitest";
import { allocateConfiguredExpense } from "@/modules/finance/domain/configured-finance-rules";
import { Money } from "@/platform/money/money";

describe("configured custom expense allocations",()=>{
  it.each([
    {amount:"100.01",shares:[2500,2500,5000],expected:["25.00","25.00","50.01"]},
    {amount:"0.01",shares:[3333,3333,3334],expected:["0.00","0.00","0.01"]},
    {amount:"0.03",shares:[4000,0,6000],expected:["0.01","0.00","0.02"]},
    {amount:"0.01",shares:[3333,6667,0],expected:["0.00","0.01","0.00"]}
  ])("conserves $amount exactly across configured owner, company and guest shares",({amount,shares,expected})=>{
    const result=allocateConfiguredExpense({default_treatment:"OWNER_PAID",categories:{maintenance:{treatment:"CUSTOM",owner_share_bps:shares[0],alvillas_share_bps:shares[1],guest_share_bps:shares[2]}}},
      {category:"maintenance",amount:Money.of(amount,"MAD")});
    expect(result.treatment).toBe("CUSTOM");expect([result.ownerAmount,result.alvillasAmount,result.guestAmount].map(money=>money.toJSON().amount)).toEqual(expected);
    expect(result.ownerAmount.add(result.alvillasAmount).add(result.guestAmount).equals(Money.of(amount,"MAD"))).toBe(true);
    expect([result.ownerShareBps,result.alvillasShareBps,result.guestShareBps]).toEqual(shares);
  });
  it.each([
    {owner_share_bps:2500,alvillas_share_bps:2500},
    {owner_share_bps:2500,alvillas_share_bps:2500,guest_share_bps:4999},
    {owner_share_bps:2500,alvillas_share_bps:2500,guest_share_bps:5001}
  ])("rejects incomplete or nonconserving custom shares instead of supplying business defaults",shares=>{
    expect(()=>allocateConfiguredExpense({default_treatment:"CUSTOM",categories:{maintenance:{treatment:"CUSTOM",...shares}}},{category:"maintenance",amount:Money.of("100","MAD")})).toThrow();
  });
});
