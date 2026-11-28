import type { AppLocale } from "@/i18n/routing";
import { escapeHtml } from "@/platform/encoding/html";
import { renderEmailDocument } from "./email-layout";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import ar from "../../../messages/ar.json";

const messages = { en, fr, ar };

export function guestHubLinkMessage(locale: AppLocale, url: string) {
  const labels = messages[locale].GuestLinkDelivery.message;
  const text = [labels.intro, url, labels.private].join("\n\n");
  const html = renderEmailDocument(locale, labels.subject, `<p>${escapeHtml(labels.intro)}</p><p><a href="${escapeHtml(url)}">${escapeHtml(labels.open)}</a></p><p>${escapeHtml(labels.private)}</p>`);
  return { subject: labels.subject, text, html, locale, template: "guest_hub.private_link" };
}
