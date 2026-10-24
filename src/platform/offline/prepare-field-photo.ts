import { fieldUploadManifestSchema, fieldUploadChunkBytes } from "@/modules/reservations/domain/field-upload";

const digest = async (blob: Blob) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
  .map(value => value.toString(16).padStart(2, "0")).join("");

export async function prepareFieldPhoto(file: File, taskId: string, note: string, localId = crypto.randomUUID()) {
  if (!["image/png", "image/jpeg"].includes(file.type) || file.size > 32 * 1024 * 1024) throw new Error("FIELD_PHOTO_INVALID");
  const bitmap = await createImageBitmap(file), canvas = document.createElement("canvas");
  let blob: Blob;
  try {
    const ratio = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d"); if (!context) throw new Error("FIELD_PHOTO_INVALID");
    context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("FIELD_PHOTO_INVALID")), "image/jpeg", 0.82));
  } finally { bitmap.close(); canvas.width = 0; canvas.height = 0; }
  const parts: Array<{ size: number; sha256: string }> = [];
  for (let offset = 0; offset < blob.size; offset += fieldUploadChunkBytes) {
    const part = blob.slice(offset, offset + fieldUploadChunkBytes); parts.push({ size: part.size, sha256: await digest(part) });
  }
  const manifest = fieldUploadManifestSchema.parse({ protocolVersion: 1, localId, taskId, contentType: blob.type, note,
    size: blob.size, sha256: await digest(blob), parts });
  return { blob, manifest };
}
