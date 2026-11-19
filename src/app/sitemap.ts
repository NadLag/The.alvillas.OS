import type { MetadataRoute } from "next";
import { publicLanguageUrls, publicWebsitePaths } from "@/platform/website/site";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicWebsitePaths.flatMap(path => {
    const languages = publicLanguageUrls(path);
    return Object.values(languages).map(url => ({
      url, alternates: { languages: { ...languages, "x-default": languages.en } }
    }));
  });
}
