import { personalDownload } from "@/modules/personal/application/personal-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ householdId: string; documentId: string }> }) {
  const document = await personalDownload(await params);
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  };
  if (!document) return new Response(null, { status: 404, headers });
  const suffix = document.contentType === "application/pdf" ? ".pdf" : document.contentType === "image/png" ? ".png" : ".jpg";
  const filename = document.displayName.toLowerCase().endsWith(suffix) ? document.displayName : document.displayName + suffix;
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (character) => `%${character.charCodeAt(0).toString(16)}`);
  return new Response(document.bytes, { headers: {
    ...headers, "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`
  } });
}
