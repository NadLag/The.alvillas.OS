import type { NextRequest } from "next/server";
import { completeFieldUpload } from "@/modules/reservations/application/field-upload-service";
import { fieldUploadRequest } from "../request";

export const maxDuration = 120;
export async function POST(request: NextRequest) {
  return fieldUploadRequest(request, (ctx, value, meta) => completeFieldUpload(ctx, value, meta));
}
