import type { NextRequest } from "next/server";
import { startFieldUpload } from "@/modules/reservations/application/field-upload-service";
import { fieldUploadRequest } from "./request";

export async function POST(request: NextRequest) {
  return fieldUploadRequest(request, (ctx, value, meta) => startFieldUpload(ctx, value, meta));
}
