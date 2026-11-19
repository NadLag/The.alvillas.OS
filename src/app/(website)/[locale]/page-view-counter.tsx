"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import type { AppLocale } from "@/i18n/routing";

export function PageViewCounter({ locale }: { locale: AppLocale }) {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (!pathname || previous.current === pathname || navigator.doNotTrack === "1") return;
    previous.current = pathname;
    void fetch("/api/public/website-analytics", {
      method: "POST", credentials: "omit", referrerPolicy: "no-referrer", keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ locale, path: pathname.slice(locale.length + 1) })
    }).catch(() => {});
  }, [locale, pathname]);
  return null;
}
