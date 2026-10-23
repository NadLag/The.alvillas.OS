"use client";

import { useState, type MouseEvent } from "react";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/i18n/locale-switch";
import type { AppLocale } from "@/i18n/routing";

export function FieldLanguage({ locale, path }: { locale: AppLocale; path: string }) {
  const t = useTranslations("Field");
  const [notice, setNotice] = useState<"saveBeforeLanguage" | "noteBeforeLanguage" | "offlineLanguage" | null>(null);
  function navigate(event: MouseEvent<HTMLDivElement>) {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!link || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (link.getAttribute("aria-current") === "page") { event.preventDefault(); return; }
    if (!navigator.onLine) { event.preventDefault(); setNotice("offlineLanguage"); return; }
    const dirty = document.querySelector<HTMLFormElement>('[data-field-dirty="true"]');
    if (!dirty) { setNotice(null); return; }
    event.preventDefault();
    const note = dirty.querySelector<HTMLTextAreaElement>('textarea[name="note"]');
    setNotice(note?.value.trim() ? "noteBeforeLanguage" : "saveBeforeLanguage");
  }
  return <div className="field-language" onClickCapture={navigate} data-testid="field-language">
    <LocaleSwitch currentLocale={locale} path={path} label={t("language")} compact />
    {notice ? <p role="status" data-testid="field-language-notice">{t(notice)}</p> : null}
  </div>;
}
