import { Document, Page, Text, View, StyleSheet, renderToBuffer } from "@react-pdf/renderer";
import type { PdfRenderer } from "@/platform/providers";
import { HttpPdfRenderer } from "@/platform/providers/real";
import { alvillasPdfFontFamily, registerAlvillasPdfFonts } from "@/platform/exports/pdf-fonts";
import { readBoundedResponseBytes } from "@/platform/http/read-exact-response";
import { documentPdfTemplate, documentPdfInputSchema, DocumentPdfConfigurationError, validateGeneratedPdf } from "../domain/document-pdf";

const styles = StyleSheet.create({
  page: { fontFamily: alvillasPdfFontFamily, fontSize: 11, lineHeight: 1.5, padding: 40, color: "#182326" },
  title: { fontSize: 21, fontWeight: 700, marginBottom: 20, color: "#0B6B5F" },
  heading: { fontSize: 15, fontWeight: 700, marginTop: 12, marginBottom: 8 },
  paragraph: { marginBottom: 10 },
  bullet: { flexDirection: "row", marginBottom: 8 }, marker: { width: 16 }, bulletText: { flex: 1 }
});

/** Plain native values become text nodes; no HTML, remote images, links or executable templates. */
export class DocumentPdfRenderer implements PdfRenderer {
  constructor(private readonly arabicRenderer?: PdfRenderer) {}
  async render(input: Parameters<PdfRenderer["render"]>[0]): Promise<Uint8Array> {
    if (input.template !== documentPdfTemplate) throw new DocumentPdfConfigurationError();
    const parsed = documentPdfInputSchema.safeParse(input.data);
    if (!parsed.success || parsed.data.source.locale !== input.locale) throw new DocumentPdfConfigurationError();
    const payload = parsed.data, source = payload.source;
    if (input.locale === "ar" || /\p{Script=Arabic}/u.test(JSON.stringify({ title: source.title, blocks: source.blocks }))) {
      if (!this.arabicRenderer) throw new DocumentPdfConfigurationError();
      try { return validateGeneratedPdf(await this.arabicRenderer.render({ ...input, data: payload }), payload.maximumBytes); }
      catch { throw new DocumentPdfConfigurationError(); }
    }
    registerAlvillasPdfFonts();
    const pdf = <Document title={source.title} language={input.locale} creator="ALVILLAS OS" producer="ALVILLAS OS"
      subject={[source.templateKey, payload.provenance.templateVersionId, payload.provenance.templateSha256, payload.provenance.sourceFingerprint].join(";")}>
      <Page size="A4" style={styles.page}><Text style={styles.title}>{source.title}</Text>
        {source.blocks.map((block, index) => block.kind === "BULLET" ?
          <View key={index} style={styles.bullet}><Text style={styles.marker}>•</Text><Text style={styles.bulletText}>{block.text}</Text></View> :
          <Text key={index} style={block.kind === "HEADING" ? styles.heading : styles.paragraph} minPresenceAhead={block.kind === "HEADING" ? 30 : undefined}>{block.text}</Text>)}
      </Page>
    </Document>;
    return validateGeneratedPdf(new Uint8Array(await renderToBuffer(pdf)), payload.maximumBytes);
  }
}

export function configuredDocumentPdfRenderer(env: Record<string, string | undefined> = process.env): PdfRenderer {
  const arabic: PdfRenderer | undefined = env.PDF_RENDERER_ENDPOINT && env.PDF_RENDERER_TOKEN ? { async render(input) {
    const payload = documentPdfInputSchema.parse(input.data), renderer = new HttpPdfRenderer(env, async (url, init) => {
      const response = await fetch(url, init);
      if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/pdf") {
        await response.body?.cancel(); throw new DocumentPdfConfigurationError();
      }
      const bytes = await readBoundedResponseBytes(response, payload.maximumBytes);
      return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "application/pdf" } });
    });
    return renderer.render(input);
  } } : undefined;
  return new DocumentPdfRenderer(arabic);
}
