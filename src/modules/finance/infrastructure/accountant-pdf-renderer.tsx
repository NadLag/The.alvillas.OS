import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, Page, Text, View, Font, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { z } from "zod";
import type { PdfRenderer } from "@/platform/providers";
import { HttpPdfRenderer } from "@/platform/providers/real";
import { validateAccountantExportDocument, AccountantExportConfigurationError } from "../domain/accountant-export";
import { accountantExportLabelsSchema } from "./accountant-tabular-renderer";

export const accountantPdfTemplate = "finance.accountant-export.v1";
const inputSchema = z.object({ source: z.unknown(), labels: accountantExportLabelsSchema, maxRows: z.number().int().positive().max(100000) }).strict();
let fontsRegistered = false;
function registerFonts() {
  if (fontsRegistered) return;
  // Fixed local assets keep financial document rendering independent of font/CDN requests.
  const regular = readFileSync(join(process.cwd(), "src/platform/exports/fonts/SourceSans3-Regular.ttf"));
  const bold = readFileSync(join(process.cwd(), "src/platform/exports/fonts/SourceSans3-Bold.ttf"));
  Font.register({ family: "Alvillas Source Sans 3", fonts: [{ src: "data:font/ttf;base64," + regular.toString("base64"), fontWeight: 400 },
    { src: "data:font/ttf;base64," + bold.toString("base64"), fontWeight: 700 }] }); fontsRegistered = true;
}
const styles = StyleSheet.create({ page: { fontFamily: "Alvillas Source Sans 3", fontSize: 9, padding: 32, color: "#182326" },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 12, color: "#0B6B5F" }, metadata: { marginBottom: 16 },
  record: { borderTopWidth: 0.5, borderTopColor: "#CDD5D0", paddingTop: 8, marginBottom: 12 },
  pair: { flexDirection: "row", marginBottom: 3 }, label: { width: "32%", paddingRight: 12, fontWeight: 700 }, value: { width: "68%" } });

/** EN/FR generation follows DEC-14. Arabic content uses the existing Chromium-capable renderer contract. */
export class AccountantPdfRenderer implements PdfRenderer {
  constructor(private readonly arabicRenderer?: PdfRenderer) {}
  async render(input: Parameters<PdfRenderer["render"]>[0]): Promise<Uint8Array> {
    if (input.template !== accountantPdfTemplate) throw new AccountantExportConfigurationError();
    const payload = inputSchema.parse(input.data), source = validateAccountantExportDocument(payload.source, payload.maxRows), labels = payload.labels;
    if (input.locale === "ar" || /\p{Script=Arabic}/u.test(JSON.stringify({ source, labels }))) {
      if (!this.arabicRenderer) throw new AccountantExportConfigurationError();
      return this.arabicRenderer.render({ ...input, data: { ...payload, source } });
    }
    registerFonts();
    const metadata = { report: labels.title, fromOn: source.fromOn, toOn: source.toOn, currency: source.currency, timezone: source.timezone,
      policyId: source.policy.id, policyVersion: String(source.policy.version), sourceFingerprint: source.sourceFingerprint, generatedAt: source.generatedAt,
      propertyId: source.scope.propertyId ?? "", ownerId: source.scope.ownerId ?? "", accountId: source.scope.accountId ?? "" };
    const document = <Document title={labels.title} language={input.locale} creator="ALVILLAS OS" producer="ALVILLAS OS">
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{labels.title}</Text>
        <View style={styles.metadata}>{Object.entries(metadata).map(([key, value]) => <View key={key} style={styles.pair}>
          <Text style={styles.label}>{labels.metadata[key as keyof typeof metadata]}</Text><Text style={styles.value}>{value}</Text>
        </View>)}</View>
        {source.rows.map(row => <View key={row.identity} style={styles.record}>{source.columns.map(column => <View key={column} style={styles.pair}>
          <Text style={styles.label}>{labels.headers[column]}</Text><Text style={styles.value}>{row.cells[column]!.value ?? ""}</Text>
        </View>)}</View>)}
      </Page>
    </Document>;
    return new Uint8Array(await renderToBuffer(document));
  }
}

export function configuredAccountantPdfRenderer(env: Record<string, string | undefined> = process.env): PdfRenderer {
  return new AccountantPdfRenderer(env.PDF_RENDERER_ENDPOINT && env.PDF_RENDERER_TOKEN ? new HttpPdfRenderer(env) : undefined);
}
