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
    return new NextResponse(null, { status: 302, headers: { ...headers, Location: result.url } });
  } catch {
    return NextResponse.json({ error: "document_unavailable" }, { status: 404, headers });
  }
}
