import { getTranslations } from "next-intl/server";
import { auth } from "@/platform/auth/session";
import { notificationActorFromSession } from "@/platform/notifications/notification-service";
import { prepareWhatsapp } from "@/platform/notifications/whatsapp-service";
import { safeLocale } from "@/i18n/routing";

export async function POST(request: Request) {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  const origin = request.headers.get("origin");
  const expectedOrigin = `${new URL(request.url).protocol}//${request.headers.get("host") ?? new URL(request.url).host}`;
  // A noreferrer navigation deliberately sends an opaque Origin. Fetch Metadata
  // is browser-controlled and must still identify a same-origin form navigation.
  const privateNavigation = origin === "null" && request.headers.get("sec-fetch-site") === "same-origin" && request.headers.get("sec-fetch-mode") === "navigate";
  if (origin !== expectedOrigin && !privateNavigation) return new Response(null, { status: 403, headers });
  const input = await request.formData();
  const localeInput = input.get("locale");
  const locale = safeLocale(typeof localeInput === "string" ? localeInput : "fr");
  try {
    const actor = await notificationActorFromSession(await auth());
    if (!actor) throw new Error("Unavailable");
    const fingerprint = input.get("fingerprint");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw new Error("Unavailable");
    const draft = await prepareWhatsapp(actor, { source: { type: input.get("type"), id: input.get("id") }, recipient: { kind: input.get("kind"), id: input.get("recipientId") }, locale }, { fingerprint }, "opened");
    return new Response(null, { status: 303, headers: { ...headers, Location: draft.url } });
  } catch {
    const t = await getTranslations({ locale, namespace: "Whatsapp" });
    return new Response(t("unavailable"), { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
  }
}
