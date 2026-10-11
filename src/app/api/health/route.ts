import { NextResponse } from "next/server";
import { readServiceInfo } from "@/platform/health/service-info";

export const runtime = "nodejs";

export function GET() {
  const service = readServiceInfo();

  return NextResponse.json({
    status: "ok",
    service: service.service,
    version: service.version,
    timestamp: service.timestamp
  });
}
