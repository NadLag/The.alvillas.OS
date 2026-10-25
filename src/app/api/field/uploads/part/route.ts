import type { NextRequest } from "next/server";
import { storeFieldUploadPart } from "@/modules/reservations/application/field-upload-service";
import { fieldUploadChunkBytes } from "@/modules/reservations/domain/field-upload";
import { readBoundedRequestBytes } from "@/platform/http/read-exact-response";
import { fieldUploadRequest } from "../request";

export async function PUT(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return fieldUploadRequest(request, (ctx, value, meta) => {
    if (!(value instanceof Uint8Array)) throw new Error("Invalid upload body");
    return storeFieldUploadPart(ctx, { organization_id: params.get("organization_id"), actor_user_id: params.get("actor_user_id"),
      device_id: params.get("device_id"), uploadId: params.get("uploadId"), index: params.has("index") ? Number(params.get("index")) : Number.NaN,
      ...(params.has("generation") ? { generation: Number(params.get("generation")) } : {}) }, value, meta);
  }, { contentType: "application/octet-stream", read: request => readBoundedRequestBytes(request, fieldUploadChunkBytes) });
}
