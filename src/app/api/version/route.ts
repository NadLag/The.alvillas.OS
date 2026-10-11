import { NextResponse } from "next/server";
import { readServiceInfo } from "@/platform/health/service-info";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(readServiceInfo());
}
