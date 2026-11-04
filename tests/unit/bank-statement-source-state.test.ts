import { describe, expect, it } from "vitest";
import { bankStatementSourceStates, bankStatementSourceFamilyMembers, type BankSourceFact } from "@/modules/finance/domain/bank-statement-source-state";

const fact = (id: string, correctsExternalId: string | null = null, correctionAction: string | null = correctsExternalId ? "REPLACE" : null): BankSourceFact =>
  ({ id, externalId: id, ledgerAccountId: "actual-bank", bankIdentityHash: "original-identity", currency: "MAD", correctsExternalId, correctionAction });
describe("retained bank correction families", () => {
  it("uses the final explicit replacement without changing any original source fact", () => {
    const input = [fact("last", "replacement"), fact("original"), fact("replacement", "original")], before = JSON.stringify(input);
    expect(Object.fromEntries(bankStatementSourceStates(input))).toEqual({ last: "ACTIVE", original: "SUPERSEDED", replacement: "SUPERSEDED" });
    expect(JSON.stringify(input)).toBe(before);
    expect(bankStatementSourceFamilyMembers(input).get("last")).toEqual(["last", "original", "replacement"]);
  });
  it("retains a deletion as nonmonetary evidence and never treats it as a bank movement", () => {
    expect(Object.fromEntries(bankStatementSourceStates([fact("original"), fact("deletion", "original", "DELETE")]))).toEqual({ original: "SUPERSEDED", deletion: "REMOVED" });
  });
  it("leaves every competing branch unresolved instead of choosing an arbitrary newest row", () => {
    const states = bankStatementSourceStates([fact("original"), fact("first", "original"), fact("second", "original"), fact("leaf", "first")]);
    expect([...states.values()]).toEqual(["AMBIGUOUS", "AMBIGUOUS", "AMBIGUOUS", "AMBIGUOUS"]);
  });
  it("does not match a correction until its actual original source arrives", () => {
    expect(bankStatementSourceStates([fact("replacement", "missing")]).get("replacement")).toBe("UNRESOLVED");
    expect(bankStatementSourceStates([fact("replacement", "missing"), fact("missing")]).get("replacement")).toBe("ACTIVE");
  });
  it("keeps identical FITIDs independent for different actual bank identities", () => {
    const other = { ...fact("other-row"), externalId: "original", bankIdentityHash: "different-actual-bank" };
    expect(bankStatementSourceStates([fact("original"), fact("replacement", "original"), other]).get("other-row")).toBe("ACTIVE");
    const families = bankStatementSourceFamilyMembers([fact("original"), fact("replacement", "original"), other]);
    expect(families.get("other-row")).toEqual(["other-row"]); expect(families.get("replacement")).toEqual(["original", "replacement"]);
  });
  it("fails closed for cycles, currency changes and attempts to replace a deletion", () => {
    expect([...bankStatementSourceStates([fact("a", "b"), fact("b", "a")]).values()]).toEqual(["AMBIGUOUS", "AMBIGUOUS"]);
    expect(bankStatementSourceStates([fact("a"), { ...fact("b", "a"), currency: "EUR" }]).get("b")).toBe("AMBIGUOUS");
    expect(bankStatementSourceStates([fact("a"), fact("b", "a", "DELETE"), fact("c", "b")]).get("c")).toBe("AMBIGUOUS");
  });
  it("retains every unidentified CSV row independently and rejects duplicate canonical identities", () => {
    expect([...bankStatementSourceStates([{ ...fact("first"), externalId: null }, { ...fact("second"), externalId: null }]).values()]).toEqual(["ACTIVE", "ACTIVE"]);
    expect(() => bankStatementSourceStates([fact("same"), fact("same")])).toThrow("invalid_bank_correction_family");
    expect(() => bankStatementSourceStates([fact("same"), { ...fact("other"), externalId: "same" }])).toThrow("duplicate_original_bank_identity");
  });
});
