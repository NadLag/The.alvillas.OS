import type { MetadataRoute } from "next";
import { publicWebsiteOrigin } from "@/platform/website/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: ["/api/", "/*/activate/", "/*/app", "/*/field", "/*/guest", "/*/owner", "/*/recover"] },
    sitemap: `${publicWebsiteOrigin}/sitemap.xml`
  };
}
