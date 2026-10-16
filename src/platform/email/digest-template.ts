import { z } from "zod";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import fr from "../../../messages/fr.json";
import ar from "../../../messages/ar.json";
import type { EmailProvider } from "@/platform/providers";
import type { DigestSettings } from "@/platform/notifications/digest";
import { operationalDigestKinds } from "@/platform/notifications/digest";
import { escapeHtml } from "@/platform/encoding/html";
import { renderEmailDocument } from "./email-layout";

export function renderDigestEmail(input: { to: string; settings: DigestSettings; scheduledAt: Date;
  items: Array<{ id: string; kind: string; createdAt: Date }>; appUrl: string }): Parameters<EmailProvider["send"]>[0] {
  const to = z.email().parse(input.to);
  const origin = new URL(input.appUrl);
  if ((origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname))) || origin.username || origin.password) throw new Error("digest_origin_invalid");
  const locale = input.settings.language; const catalog = { en, fr, ar }[locale]; const labels = catalog.Notifications.digest;
  const date = new Intl.DateTimeFormat(locale, { timeZone: input.settings.timezone, dateStyle: "long" }).format(input.scheduledAt);
  const summary = createTranslator({ locale, messages: labels })("summary", { count: input.items.length, date });
  const links = input.items.map((item) => {
    z.uuid().parse(item.id);
    const kind = z.enum(operationalDigestKinds).parse(item.kind);
    const label = catalog.Notifications.kinds[kind];
    const url = new URL(`/${locale}/app/notifications/open/${item.id}`, origin).href;
    return { label, url };
  });
  const settingsUrl = new URL(`/${locale}/app/notifications`, origin).href;
  const text = [summary, ...links.map(({ label, url }) => `${label}: ${url}`), labels.privacy, `${labels.manage}: ${settingsUrl}`].join("\n\n");
  const html = renderEmailDocument(locale, labels.subject, `<p>${escapeHtml(summary)}</p><ul>${links.map(({ label, url }) => `<li><a href="${escapeHtml(url)}">${escapeHtml(label)}</a></li>`).join("")}</ul><p>${escapeHtml(labels.privacy)}</p><p><a href="${escapeHtml(settingsUrl)}">${escapeHtml(labels.manage)}</a></p>`);
  return { to, subject: labels.subject, html, text, locale, template: "notification.digest" };
}
