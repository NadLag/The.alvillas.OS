import type { MetadataRoute } from "next";
import en from "../../messages/en.json";
import { fieldManifest } from "@/platform/offline/field-manifest";

export default function manifest(): MetadataRoute.Manifest {
  return fieldManifest("en", en.Metadata);
}
