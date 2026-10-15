import type { MetadataRoute } from "next";
import en from "../../messages/en.json";

export default function manifest(): MetadataRoute.Manifest {
  return { id: "/", name: en.Metadata.title, short_name: "ALVILLAS OS", description: en.Metadata.description,
    start_url: "/en/app", scope: "/", display: "standalone", background_color: "#F5F6F2", theme_color: "#0B6B5F",
    icons: [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] };
}
