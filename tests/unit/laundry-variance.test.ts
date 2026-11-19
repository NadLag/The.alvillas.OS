import {describe,it,expect} from "vitest";
import {exactVariancePercentage,varianceFactsSchema} from "@/modules/finance/domain/variance-facts";
import {formatPercentageAmount} from "@/i18n/format";
describe("native laundry variance",()=>{
 it("keeps signed exact percentages, half-away rounding and a zero baseline",()=>{
  expect(exactVariancePercentage("850.00","920.00","MAD")).toBe("8.2");
  expect(exactVariancePercentage("850.00","780.00","MAD")).toBe("-8.2");
  expect(exactVariancePercentage("200.00","200.10","MAD")).toBe("0.1");
  expect(exactVariancePercentage("200.00","199.90","MAD")).toBe("-0.1");
  expect(exactVariancePercentage("0.00","920.00","MAD")).toBeNull();
  expect(exactVariancePercentage("1000000000000000000000000000000000000.00","1082000000000000000000000000000000000.00","MAD")).toBe("8.2");
 });
 it("localizes percentages without converting monetary amounts to Number",()=>{
  expect(formatPercentageAmount("en","8.2")).toBe("+8.2%");
  expect(formatPercentageAmount("fr","-8.2")).toContain("8,2");
  expect(formatPercentageAmount("ar","8.2")).toBe(new Intl.NumberFormat("ar",{style:"percent",minimumFractionDigits:1,maximumFractionDigits:1,signDisplay:"exceptZero"}).format(0.082));
 });
 it("represents unavailable comparisons with original currencies and no fabricated money",()=>{
  const facts={kind:"UNAVAILABLE",unit:"LAUNDRY",currency:null,expected:null,actual:null,variance:null,reason:"CURRENCY_MISMATCH",expectedMoney:{amount:"850.00",currency:"MAD"},actualMoney:[{amount:"920.00",currency:"EUR"}]};
  expect(varianceFactsSchema.parse(facts)).toEqual(facts);
  expect(varianceFactsSchema.safeParse({...facts,variance:"70.00"}).success).toBe(false);
  expect(varianceFactsSchema.safeParse({kind:"MONEY",unit:"MONEY:MAD",currency:"MAD",expected:"850.00",actual:"920.00",variance:"70.00"}).success).toBe(true);
 });
});
