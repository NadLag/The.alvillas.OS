import { z } from "zod";

export const personalDocumentLimit = 3_000_000;
export const personalDocumentTypes = ["application/pdf", "image/jpeg", "image/png"] as const;

export const personalDocumentSchema = z.object({
  id: z.uuid(), displayName: z.string().trim().min(1).max(120).regex(/^[^\p{Cc}]+$/u),
  file: z.file().min(1).max(personalDocumentLimit).mime([...personalDocumentTypes])
}).strict();

export function documentMatchesType(bytes: Buffer, mime: string) {
  switch (mime) {
    case "application/pdf":
      return bytes.subarray(0, 5).toString("ascii") === "%PDF-" &&
        bytes.subarray(-1024).toString("ascii").trimEnd().endsWith("%%EOF");
    case "image/png":
      return bytes.length > 20 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        && bytes.subarray(-8, -4).toString("ascii") === "IEND";
    case "image/jpeg":
      return bytes.length > 4 && bytes.subarray(0, 3).toString("hex") === "ffd8ff" &&
        bytes.subarray(-2).toString("hex") === "ffd9";
    default:
      return false;
  }
}
