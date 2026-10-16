import { verifyDigestReceipt } from "@/platform/email/digest-receipt";
import { recordDigestReceipt } from "@/platform/notifications/digest-service";
import { logger } from "@/platform/observability/logger";

export const runtime = "nodejs";
export async function POST(request: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return Response.json({ ok: false }, { status: 503 });
  if (Number(request.headers.get("content-length") ?? 0) > 65536) return Response.json({ ok: false }, { status: 413 });
  const body = await request.text();
  if (body.length > 65536) return Response.json({ ok: false }, { status: 413 });
  let receipt;
  try { receipt = verifyDigestReceipt(body, request.headers, secret); }
  catch { return Response.json({ ok: false }, { status: 401 }); }
  if (!receipt) return Response.json({ ok: true });
  try { const ok = await recordDigestReceipt(receipt); return Response.json({ ok }, { status: ok ? 200 : 503 }); }
  catch { logger.error("digest receipt storage failed", { organizationId: receipt.data.tags.organization_id }); return Response.json({ ok: false }, { status: 503 }); }
}
