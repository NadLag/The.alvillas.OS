import worker from "@/platform/offline/worker-code.generated.json";
import { readServiceInfo } from "@/platform/health/service-info";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET() {
  return new Response(`self.ALVILLAS_RELEASE = ${JSON.stringify(readServiceInfo().version)};\n${worker.code}`, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate",
      "Service-Worker-Allowed": "/", "X-Content-Type-Options": "nosniff" }
  });
}
