import { describe, expect, it } from "vitest";
import { readBankStatementBody } from "@/modules/finance/ui/bank-statement-body";
import { BankStatementAccessError, BankStatementValidationError } from "@/modules/finance/domain/bank-statement";

const request = (form: FormData, origin = "https://app.example.test") => new Request("https://app.example.test/api/finance/bank-statements/review", { method: "POST", headers: { Origin: origin }, body: form });
function body() { const form = new FormData(); form.set("input", JSON.stringify({ reason: "Vérifier l’original — مصدر أصلي" })); form.set("file", new File(["Date;Amount\n2026-11-03;0.01"], "original.csv")); return form; }
describe("bounded private original bank upload", () => {
  it("retains original bytes and Unicode metadata without accepting them in URLs", async () => {
    const result = await readBankStatementBody(request(body()));
    expect(result.input).toEqual({ reason: "Vérifier l’original — مصدر أصلي" });
    expect(new TextDecoder().decode(result.bytes)).toBe("Date;Amount\n2026-11-03;0.01");
  });
  it("denies a foreign origin before reading the body", async () => {
    await expect(readBankStatementBody(request(body(), "https://foreign.example.test"))).rejects.toBeInstanceOf(BankStatementAccessError);
  });
  it("rejects duplicate metadata, extra parts, missing files and invalid metadata", async () => {
    for (const change of [(form: FormData) => form.append("input", "{}"), (form: FormData) => form.set("unexpected", "data"), (form: FormData) => form.delete("file"), (form: FormData) => form.set("input", "not-json"), (form: FormData) => form.set("file", "not-a-file")]) {
      const form = body(); change(form); await expect(readBankStatementBody(request(form))).rejects.toBeInstanceOf(BankStatementValidationError);
    }
  });
  it("bounds declared request size before buffering an oversized body", async () => {
    const incoming = request(body()); incoming.headers.set("content-length", String(11 * 1024 * 1024));
    await expect(readBankStatementBody(incoming)).rejects.toBeInstanceOf(BankStatementValidationError);
  });
});
