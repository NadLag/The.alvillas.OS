import Decimal from "decimal.js";

const currencyPattern = /^[A-Z]{3}$/;

export type MoneyInput = string | Decimal;

export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: string
  ) {}

  static of(amount: MoneyInput, currency: string): Money {
    if (!currencyPattern.test(currency)) {
      throw new Error(`Invalid ISO 4217 currency: ${currency}`);
    }

    if (typeof amount === "number") {
      throw new Error("Money amount must be a string or Decimal, never a JavaScript number");
    }

    const value = new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    if (!value.isFinite()) {
      throw new Error("Money amount must be finite");
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return Money.of("0", currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits() + other.minorUnits(), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits() - other.minorUnits(), this.currency);
  }

  multiply(rate: MoneyInput): Money {
    const multiplier = new Decimal(rate);
    if (!multiplier.isFinite()) throw new Error("Money rate must be finite");
    const ProductDecimal = Decimal.clone({ precision: Math.max(Decimal.precision, this.amount.precision() + multiplier.precision() + 2) });
    return Money.of(new ProductDecimal(this.amount.toFixed()).mul(multiplier.toFixed()).toFixed(), this.currency);
  }

  /** Round an exact fraction once, including thirds and large monetary values. */
  multiplyRatio(numerator: bigint, denominator: bigint): Money {
    if (denominator <= 0n) throw new Error("Money ratio denominator must be positive");
    const product = this.minorUnits() * numerator, negative = product < 0n;
    const absolute = negative ? -product : product;
    const rounded = absolute / denominator + (absolute % denominator * 2n >= denominator ? 1n : 0n);
    return Money.fromMinorUnits(negative ? -rounded : rounded, this.currency);
  }

  splitByRate(rate: MoneyInput): { allocated: Money; remainder: Money } {
    const allocated = this.multiply(rate);
    return {
      allocated,
      remainder: this.subtract(allocated)
    };
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.eq(other.amount);
  }

  isAtLeastBasisPointsOf(other: Money, basisPoints: number): boolean {
    this.assertSameCurrency(other);
    if (!Number.isSafeInteger(basisPoints) || basisPoints < 0) {
      throw new Error("Money basis points must be a nonnegative safe integer");
    }
    return this.minorUnits() * 10000n >= other.minorUnits() * BigInt(basisPoints);
  }

  toJSON(): { amount: string; currency: string } {
    return {
      amount: this.amount.toFixed(2),
      currency: this.currency
    };
  }

  toString(): string {
    return `${this.amount.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new Error(`Cannot mix ${this.currency} and ${other.currency}`);
    }
  }

  private minorUnits(): bigint {
    return BigInt(this.amount.toFixed(2).replace(".", ""));
  }

  private static fromMinorUnits(units: bigint, currency: string): Money {
    const negative = units < 0n;
    const digits = (negative ? -units : units).toString().padStart(3, "0");
    return Money.of(`${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`, currency);
  }
}
