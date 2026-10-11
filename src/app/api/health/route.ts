import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "alvillas-os",
    version: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    timestamp: new Date().toISOString()
  });
}
