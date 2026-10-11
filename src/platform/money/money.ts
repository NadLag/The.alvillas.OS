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
    return Money.of(this.amount.plus(other.amount), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amount.minus(other.amount), this.currency);
  }

  multiply(rate: MoneyInput): Money {
    return Money.of(this.amount.mul(new Decimal(rate)), this.currency);
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
}
