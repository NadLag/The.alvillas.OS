import { randomUUID } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { accountantExportColumns, AccountantExportCapacityError, AccountantExportSourceError } from "@/modules/finance/domain/accountant-export";
import { renderAccountantCsv, renderAccountantExcel, type AccountantExportLabels } from "@/modules/finance/infrastructure/accountant-tabular-renderer";
import { spreadsheetText } from "@/platform/exports/spreadsheet-cell";

const source = () => ({ organizationId: randomUUID(), kind: "TRANSACTIONS", currency: "MAD", fromOn: "2031-05-01", toOn: "2031-05-31", timezone: "Africa/Casablanca",
  policy: { id: randomUUID(), version: 2 }, sourceFingerprint: "a".repeat(64), generatedAt: "2031-06-01T00:00:00Z", columns: ["postingId", "amount", "description"],
  rows: [{ identity: randomUUID(), cells: { postingId: { kind: "IDENTIFIER", value: randomUUID() }, amount: { kind: "MONEY", value: "-9007199254740993.07" },
    description: { kind: "TEXT", value: '=HYPERLINK("https://foreign.example", "Original <&> data")' } } }] });
const labels: AccountantExportLabels = { title: "Configured original transactions", headers: Object.fromEntries(accountantExportColumns.map(key => [key, key])) as AccountantExportLabels["headers"],
  metadata: { recordType: "recordType", report: "report", fromOn: "fromOn", toOn: "toOn", currency: "currency", timezone: "timezone", policyId: "policyId", policyVersion: "policyVersion", sourceFingerprint: "sourceFingerprint", generatedAt: "generatedAt", propertyId: "propertyId", ownerId: "ownerId", accountId: "accountId" },
  metadataRow: "metadata", sourceRow: "source", metadataSheet: "Metadata", dataSheet: "Original entries" };

describe("real complete accountant tabular attachments", () => {
  it("writes one BOM, source metadata and exact signed money while escaping only free-text formulas", () => {
    const document = source(), before = structuredClone(document), bytes = renderAccountantCsv(document, labels, 10), text = new TextDecoder().decode(bytes);
    expect([...bytes.slice(0, 3)]).toEqual([239, 187, 191]);
    expect(text.split("\r\n").filter(Boolean)).toHaveLength(3);
    expect(text).toContain('"-9007199254740993.07"'); expect(text).not.toContain("'-9007199254740993.07");
    expect(text).toContain('"\'=HYPERLINK(""https://foreign.example"", ""Original <&> data"")"');
    expect(text).toContain(document.policy.id); expect(text).toContain(document.sourceFingerprint); expect(document).toEqual(before);
  });
  it.each(["=1+1", "+1", "-1", "@SUM(A1)", " \t=1", "\u200B=1", "\r\n@SUM(A1)"])("prevents formula interpretation after leading control and format characters: %s", value => {
    expect(spreadsheetText(value)).toBe("'" + value);
  });
  it("produces a real XLSX with typed exact string cells and no formulas, hyperlinks or external relations", async () => {
    const document = source(), before = structuredClone(document), bytes = await renderAccountantExcel(document, labels, "fr", 10), archive = unzipSync(bytes);
    expect([...bytes.slice(0, 2)]).toEqual([80, 75]);
    expect(archive["[Content_Types].xml"]).toBeDefined();
    const xml = Object.entries(archive).filter(([name]) => name.endsWith(".xml")).map(([, value]) => strFromU8(value)).join("\n");
    expect(xml).toContain("-9007199254740993.07"); expect(xml).toContain("=HYPERLINK("); expect(xml).toContain("Original &lt;&amp;&gt; data");
    expect(xml).toContain(document.policy.id); expect(xml).toContain(document.sourceFingerprint);
    expect(xml).not.toMatch(/<f(?:\s|>)/u); expect(xml).not.toContain("<hyperlink"); expect(Object.keys(archive).some(name => name.includes("externalLink"))).toBe(false);
    expect(xml).toMatch(/t="(?:inlineStr|s)"/u); expect(document).toEqual(before);
  });
  it("retains explicit Arabic sheet direction and Unicode source text without changing numeric bytes", async () => {
    const document = source(); document.rows[0].cells.description.value = "حركة مالية أصلية / écriture réelle";
    const archive = unzipSync(await renderAccountantExcel(document, { ...labels, title: "حركات أصلية", metadataSheet: "البيانات", dataSheet: "الحركات" }, "ar", 10));
    const xml = Object.values(archive).map(value => strFromU8(value)).join("\n");
    expect(xml).toContain('rightToLeft="1"'); expect(xml).toContain(document.rows[0].cells.description.value); expect(xml).toContain("-9007199254740993.07");
  });
  it("keeps empty reports identifiable and rejects incomplete or over-capacity documents before either renderer emits bytes", async () => {
    const document = source(), propertyId = randomUUID(), emptySource = { ...document, rows: [], scope: { propertyId, ownerId: null, accountId: null } }, empty = new TextDecoder().decode(renderAccountantCsv(emptySource, labels, 1));
    expect(empty).toContain(propertyId);
    const archive = unzipSync(await renderAccountantExcel(emptySource, labels, "en", 1));
    expect(Object.values(archive).map(bytes => strFromU8(bytes)).join("\n")).toContain(propertyId);
    expect(empty).toContain(document.sourceFingerprint); expect(empty.split("\r\n").filter(Boolean)).toHaveLength(2);
    const invalid = { ...document, rows: [{ ...document.rows[0], cells: { ...document.rows[0].cells, amount: { kind: "MONEY", value: "0.001" } } }] };
    expect(() => renderAccountantCsv(invalid, labels, 10)).toThrow(AccountantExportSourceError);
    await expect(renderAccountantExcel(invalid, labels, "en", 10)).rejects.toThrow(AccountantExportSourceError);
    const over = { ...document, rows: [document.rows[0], { ...document.rows[0], identity: randomUUID() }] };
    expect(() => renderAccountantCsv(over, labels, 1)).toThrow(AccountantExportCapacityError);
    await expect(renderAccountantExcel(over, labels, "en", 1)).rejects.toThrow(AccountantExportCapacityError);
  });
});
