import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import { alvillasPdfFontFamily, registerAlvillasPdfFonts } from "@/platform/exports/pdf-fonts";
import { HttpPdfRenderer } from "@/platform/providers/real";
import type { OwnerStatementDocument } from "../application/owner-statement-documents";

const styles = StyleSheet.create({
  page: { padding: 36, color: "#182326", fontFamily: alvillasPdfFontFamily, fontSize: 10, lineHeight: 1.4 },
  title: { color: "#0B6B5F", fontSize: 22, fontWeight: 700, marginBottom: 10 },
  rows: { marginTop: 18 }, row: { borderTopWidth: 0.5, borderTopColor: "#CDD5D0", paddingTop: 5, marginBottom: 5 }
});

export class OwnerStatementPdfUnavailableError extends Error {}

export async function renderOwnerStatementDownloadPdf(content: OwnerStatementDocument) {
  if (content.locale === "ar" || /\p{Script=Arabic}/u.test(content.text)) {
    if (!process.env.PDF_RENDERER_ENDPOINT || !process.env.PDF_RENDERER_TOKEN) throw new OwnerStatementPdfUnavailableError();
    const bytes = await new HttpPdfRenderer().render({ template: content.template, locale: content.locale, data: content.data });
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new OwnerStatementPdfUnavailableError();
    return bytes;
  }
  await registerAlvillasPdfFonts();
  const [title, ...lines] = content.text.split("\n");
  const document = <Document title={content.title} language={content.locale}>
    <Page size="A4" style={styles.page}>
      <Text style={styles.title}>{title}</Text>
      <View style={styles.rows}>{lines.map((line, index) => <Text key={index} style={styles.row}>{line}</Text>)}</View>
    </Page>
  </Document>;
  return new Uint8Array(await renderToBuffer(document));
}
