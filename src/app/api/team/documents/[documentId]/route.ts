import { NextResponse } from "next/server";
import { auth } from "@/platform/auth/session";
import { teamActorContextFromSession } from "@/modules/identity/application/team-service";
import { downloadTeamDocument } from "@/modules/identity/application/team-documents";

export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const ctx = await teamActorContextFromSession(await auth());
  const headers = {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  };
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers });
  try {
    const result = await downloadTeamDocument(ctx, (await params).documentId);
    const extension =
      result.contentType === "application/pdf"
        ? ".pdf"
        : result.contentType === "image/png"
          ? ".png"
          : ".jpg";
    const filename = encodeURIComponent(result.title + extension).replaceAll("'", "%27");
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        ...headers,
        "Content-Type": result.contentType,
        "Content-Length": String(result.bytes.length),
        "Content-Disposition": `attachment; filename*=UTF-8''${filename}`
      }
    });
  } catch {
    return NextResponse.json({ error: "document_unavailable" }, { status: 404, headers });
  }
}
