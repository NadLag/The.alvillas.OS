import { describe, expect, it } from "vitest";
import { formatCurrency, formatDate, formatNumber, pluralCategory } from "@/i18n/format";
import { Money } from "@/platform/money/money";

describe("i18n formatters", () => {
  it("formats dates with an explicit default timezone", () => {
    expect(formatDate("en", new Date("2026-10-11T10:00:00.000Z"))).toContain("2026");
  });

  it("formats numbers by locale", () => {
    expect(formatNumber("fr", "1234.5", { minimumFractionDigits: 1 })).toContain("1");
  });

  it("formats currency from Money values", () => {
    expect(formatCurrency("en", Money.of("1234.50", "MAD"))).toContain("MAD");
  });

  it("exposes plural categories for localized messages", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 2)).toBe("other");
  });

  it("rejects unsafe display conversion for oversized values", () => {
    expect(() => formatNumber("en", "9007199254740992")).toThrow(
      "Number.MAX_SAFE_INTEGER"
    );
  });
});
