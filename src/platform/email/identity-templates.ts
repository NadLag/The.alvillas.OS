import { z } from "zod";
import en from "../../../messages/en.json" with { type: "json" };
import fr from "../../../messages/fr.json" with { type: "json" };
import ar from "../../../messages/ar.json" with { type: "json" };
import { formatDateTime } from "@/i18n/format";
import type { EmailProvider } from "@/platform/providers";
import { renderEmailDocument } from "./email-layout";
import { escapeHtml } from "@/platform/encoding/html";

const catalogs = { en, fr, ar };
const deliverySchema = z.object({
  channel: z.literal("email"),
  toEmail: z.string().trim().email(),
  locale: z.enum(["en", "fr", "ar"]),
  expiresAt: z.iso.datetime(),
});
const invitationSchema = deliverySchema.extend({
  activationCode: z.string().regex(/^[A-Za-z0-9_-]{16,200}$/u),
  activationUrl: z.string().url(),
});
const recoverySchema = deliverySchema.extend({
  recoveryCode: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/u),
  recoveryUrl: z.string().url(),
});

export class EmailDeliveryValidationError extends Error {
  constructor() { super("Invalid or expired identity email delivery"); }
}

export function renderIdentityEmail(type: string, payload: unknown, appUrl: string, now = new Date()): Parameters<EmailProvider["send"]>[0] {
  try {
    const invitation = type === "identity.invitation.delivery_requested";
    if (!invitation && type !== "identity.recovery.delivery_requested") throw new EmailDeliveryValidationError();
    const data = invitation ? invitationSchema.parse(payload) : recoverySchema.parse(payload);
    const url = new URL("activationUrl" in data ? data.activationUrl : data.recoveryUrl);
    const origin = new URL(appUrl);
    const localHttp = origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
    if ((origin.protocol !== "https:" && !localHttp) || url.origin !== origin.origin || url.username || url.password || url.search || url.hash) throw new EmailDeliveryValidationError();
    const expectedPath = invitation ? `/${data.locale}/activate/${"activationCode" in data ? data.activationCode : ""}` : `/${data.locale}/recover`;
    if (url.pathname !== expectedPath || new Date(data.expiresAt) <= now) throw new EmailDeliveryValidationError();
    const labels = catalogs[data.locale].emailTemplates[invitation ? "invitation" : "recovery"];
    const code = "activationCode" in data ? data.activationCode : data.recoveryCode;
    const expires = labels.expires.replace("{date}", formatDateTime(data.locale, new Date(data.expiresAt)));
    const text = [labels.body, `${labels.action}: ${url.href}`, `${labels.code}: ${code}`, expires, labels.footer].join("\n\n");
    const paragraphs = [labels.body, `${labels.code}: ${code}`, expires, labels.footer].map((line) => `<p>${escapeHtml(line)}</p>`);
    const html = renderEmailDocument(data.locale, labels.subject, `${paragraphs[0]}<p><a href="${escapeHtml(url.href)}">${escapeHtml(labels.action)}</a></p>${paragraphs.slice(1).join("")}`);
    return { to: data.toEmail, subject: labels.subject, html, text, locale: data.locale, template: invitation ? "identity.invitation" : "identity.recovery" };
  } catch { throw new EmailDeliveryValidationError(); }
}
