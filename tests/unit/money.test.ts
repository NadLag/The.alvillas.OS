import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import fc from "fast-check";
import { Money } from "@/platform/money/money";

describe("Money", () => {
  it("calculates exact configured basis-point amounts across individual and 500-property balances without changing Decimal defaults", () => {
    const minorText = (value: bigint) => { const negative=value<0n,digits=(negative?-value:value).toString().padStart(3,"0");return `${negative?"-":""}${digits.slice(0,-2)}.${digits.slice(-2)}`; };
    const precision = Decimal.precision;
    expect(Money.of("3115264797507789059.83","MAD").multiply("0.321").toJSON().amount).toBe("1000000000000000288.21");
    fc.assert(fc.property(fc.bigInt({min:-499999999999999999500n,max:499999999999999999500n}),fc.integer({min:0,max:10000}),(cents,bps)=>{
      const magnitude=cents<0n?-cents:cents,rounded=(magnitude*BigInt(bps)+5000n)/10000n,expected=cents<0n?-rounded:rounded;
      expect(Money.of(minorText(cents),"MAD").multiply(new Decimal(bps).div(10000)).toJSON().amount).toBe(minorText(expected));
    }),{numRuns:1000});
    expect(Decimal.precision).toBe(precision);
  });
  it("retains every cent across 500 property balances beyond an individual Decimal operation precision",()=>{
    const amount=Money.of("9999999999999999.99","MAD");let total=Money.zero("MAD");for(let index=0;index<500;index++)total=total.add(amount);
    expect(total.toJSON().amount).toBe("4999999999999999995.00");
    expect(total.add(Money.of("0.01","MAD")).subtract(Money.of("0.02","MAD")).toJSON().amount).toBe("4999999999999999994.99");
    expect(Money.zero("MAD").subtract(total).add(Money.of("0.01","MAD")).toJSON().amount).toBe("-4999999999999999994.99");
  });
  it("rounds half-up to two decimals", () => {
    expect(Money.of("10.005", "MAD").toJSON()).toEqual({
      amount: "10.01",
      currency: "MAD"
    });
  });

  it("adds and subtracts values in the same currency", () => {
    const total = Money.of("100.00", "MAD").add(Money.of("25.50", "MAD"));
    expect(total.subtract(Money.of("10.25", "MAD")).toString()).toBe("115.25 MAD");
  });

  it("rejects cross-currency arithmetic", () => {
    expect(() => Money.of("1.00", "MAD").add(Money.of("1.00", "EUR"))).toThrow(
      "Cannot mix MAD and EUR"
    );
  });

  it("rejects JavaScript number input at runtime", () => {
    expect(() => Money.of(0.1 as never, "MAD")).toThrow(
      "Money amount must be a string or Decimal"
    );
  });

  it("rejects non-finite amounts", () => {
    expect(() => Money.of("Infinity", "MAD")).toThrow("Money amount must be finite");
  });

  it("splits a percentage with the rounded amount and remainder", () => {
    const split = Money.of("8000.00", "MAD").splitByRate(new Decimal("0.20"));

    expect(split.allocated.toString()).toBe("1600.00 MAD");
    expect(split.remainder.toString()).toBe("6400.00 MAD");
  });
});
