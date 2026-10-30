import { describe, expect, it } from "vitest";
import { Money } from "@/platform/money/money";
import { employeeCompensationAmount } from "@/modules/finance/domain/employee-compensation";
import fc from "fast-check";

describe("exact contractual compensation calculations", () => {
  it("conserves large minor units through rational multiplication", () => {
    const amount = Money.of("9999999999999999.99", "MAD");
    expect(amount.multiplyRatio(2n, 3n).toJSON()).toEqual({ amount: "6666666666666666.66", currency: "MAD" });
    expect(amount.multiplyRatio(3n, 3n).equals(amount)).toBe(true);
    expect(amount.multiplyRatio(0n, 3n).toJSON().amount).toBe("0.00");
  });
  it.each([ ["0.01", 1n, 2n, "0.01"], ["-0.01", 1n, 2n, "-0.01"], ["0.01", -1n, 2n, "-0.01"],
    ["0.01", 1n, 3n, "0.00"], ["0.02", 1n, 3n, "0.01"], ["-0.02", 1n, 3n, "-0.01"] ] as const)("rounds %s × %s/%s once", (amount, numerator, denominator, expected) => {
    expect(Money.of(amount, "MAD").multiplyRatio(numerator, denominator).toJSON().amount).toBe(expected);
  });
  it.each([0n, -1n])("rejects denominator %s", denominator => {
    expect(() => Money.of("1", "EUR").multiplyRatio(1n, denominator)).toThrow("denominator");
  });
  it("keeps the rounding error within half a cent across large signed rational products", () => {
    const minorText = (units: bigint) => {
      const negative = units < 0n, digits = (negative ? -units : units).toString().padStart(3, "0");
      return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
    };
    fc.assert(fc.property(fc.bigInt({ min: -999999999999999999999n, max: 999999999999999999999n }),
      fc.bigInt({ min: -999999999999n, max: 999999999999n }), fc.bigInt({ min: 1n, max: 999999999999n }), (cents, numerator, denominator) => {
        const result = Money.of(minorText(cents), "MAD").multiplyRatio(numerator, denominator);
        const rounded = BigInt(result.toJSON().amount.replace(".", "")), difference = rounded * denominator - cents * numerator;
        expect((difference < 0n ? -difference : difference) * 2n <= denominator).toBe(true);
        expect(result.currency).toBe("MAD");
      }), { numRuns: 1000 });
  });
  it("uses each assignment's actual contractual rate for job and hourly bases", () => {
    expect(employeeCompensationAmount({ mode: "PER_JOB", amount: Money.of("500.25", "MAD") }, { mode: "PER_JOB", jobs: "3" }).toJSON().amount).toBe("1500.75");
    expect(employeeCompensationAmount({ mode: "PER_HOUR", amount: Money.of("500.25", "MAD") }, { mode: "PER_HOUR", seconds: "60" }).toJSON().amount).toBe("8.34");
    expect(employeeCompensationAmount({ mode: "PER_HOUR", amount: Money.of("0.01", "MAD") }, { mode: "PER_HOUR", seconds: "1800" }).toJSON().amount).toBe("0.01");
  });
  it("requires an explicit monthly fraction and computes configured percentages exactly", () => {
    expect(employeeCompensationAmount({ mode: "PER_MONTH", amount: Money.of("3500.25", "MAD") }, { mode: "PER_MONTH", numerator: "10", denominator: "31" }).toJSON().amount).toBe("1129.11");
    expect(employeeCompensationAmount({ mode: "PERCENTAGE", amount: Money.of("12.34", "EUR") }, { mode: "PERCENTAGE", baseAmount: "9999999999999999.99" }).toJSON()).toEqual({ amount: "1234000000000000.00", currency: "EUR" });
  });
  it.each([
    { mode: "PER_JOB", jobs: "1.5" }, { mode: "PER_JOB", jobs: "0" }, { mode: "PER_HOUR", seconds: "-1" },
    { mode: "PER_MONTH", numerator: "1", denominator: "0" }, { mode: "PER_MONTH", numerator: "1", denominator: "1", rate: "99999" },
    { mode: "PERCENTAGE", baseAmount: "1.005" }, { mode: "PERCENTAGE", baseAmount: "-1.00" }
  ])("rejects an invalid or mismatched basis %#", basis => {
    expect(() => employeeCompensationAmount({ mode: basis.mode, amount: Money.of("1", "MAD") }, basis)).toThrow();
  });
});
