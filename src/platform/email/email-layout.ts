import type { AppLocale } from "@/i18n/routing";
import { escapeHtml } from "@/platform/encoding/html";

export function renderEmailDocument(locale: AppLocale, subject: string, content: string): string {
  return `<!doctype html><html lang="${locale}" dir="${locale === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body><h1>${escapeHtml(subject)}</h1>${content}</body></html>`;
}
