"use client";

import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { whatsappContactAction, whatsappPrepareAction } from "./whatsapp-actions";
import { whatsappContactSchema, whatsappRequestSchema, type WhatsappOption, type WhatsappSource } from "./whatsapp";

export function WhatsappComposer({ source, options, contact }: { source: WhatsappSource; options: WhatsappOption[]; contact: { phone: string; locale: "en" | "fr" | "ar" } | null }) {
  const t = useTranslations("Whatsapp");
  const [selection, setSelection] = useState("0");
  const [locale, setLocale] = useState(options[0]?.locale ?? "fr");
  const [draft, setDraft] = useState<{ phone: string; message: string; fingerprint: string } | null>(null);
  const [error, setError] = useState<"unavailable" | "missingPhone" | "invalidPhone" | null>(null);
  const [offline, setOffline] = useState(false);
  const [pending, startTransition] = useTransition();
  const [contactPhone, setContactPhone] = useState(contact?.phone ?? "");
  const [contactLocale, setContactLocale] = useState(contact?.locale ?? "fr");
  const [contactStatus, setContactStatus] = useState<"savedContact" | "invalidPhone" | "unavailable" | null>(null);
  const option = options[Number(selection)];
  useEffect(() => {
    const network = () => { setOffline(!navigator.onLine); if (!navigator.onLine) setDraft(null); };
    queueMicrotask(network);
    window.addEventListener("online", network); window.addEventListener("offline", network);
    return () => { window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, []);
  function prepare() {
    const parsed = whatsappRequestSchema.safeParse({ source, recipient: option && { kind: option.kind, id: option.id }, locale });
    setDraft(null); setError(null);
    if (!parsed.success) { setError("unavailable"); return; }
    startTransition(async () => {
      try {
        const result = await whatsappPrepareAction(parsed.data);
        if (!result.ok) setError(result.error); else if (navigator.onLine) setDraft(result.draft);
      } catch { setError("unavailable"); }
    });
  }
  return <section className="whatsapp-composer" data-testid="whatsapp-composer" aria-busy={pending}>
    <p className="notification-policy">{t("manual")}</p>
    {offline ? <p role="status">{t("offline")}</p> : null}
    {!options.length ? <p role="status">{t("empty")}</p> : <>
      <label className="field"><span>{t("recipient")}</span><select data-testid="whatsapp-recipient" value={selection} disabled={pending} onChange={(event) => {
        setSelection(event.target.value); setLocale(options[Number(event.target.value)].locale); setDraft(null); setError(null);
      }}>{options.map((recipient, index) => <option key={`${recipient.kind}-${recipient.id}`} value={String(index)}>{t(`kinds.${recipient.kind}`)} · {recipient.name}</option>)}</select></label>
      <label className="field"><span>{t("language")}</span><select data-testid="whatsapp-locale" value={locale} disabled={pending} onChange={(event) => { setLocale(event.target.value as typeof locale); setDraft(null); setError(null); }}>
        {(["en", "fr", "ar"] as const).map((language) => <option key={language} value={language}>{t(`languages.${language}`)}</option>)}
      </select></label>
      {error ? <p role="alert">{t(error)}</p> : null}
      <button type="button" className={draft ? "secondary-button" : "primary-button"} data-testid="whatsapp-prepare" disabled={pending || offline} onClick={prepare}>{t(pending ? "preparing" : "prepare")}</button>
      {draft ? <div className="whatsapp-preview" data-testid="whatsapp-preview">
        <p role="status">{t("ready")}</p><p><bdi dir="ltr">{draft.phone}</bdi></p>
        <label className="field"><span>{t("preview")}</span><textarea data-testid="whatsapp-message" readOnly dir="auto" value={draft.message} rows={6} /></label>
        <form action="/api/notifications/whatsapp/open" method="post" target="_blank" rel="noopener noreferrer">
          <input type="hidden" name="type" value={source.type} /><input type="hidden" name="id" value={source.id} />
          <input type="hidden" name="kind" value={option.kind} /><input type="hidden" name="recipientId" value={option.id} /><input type="hidden" name="locale" value={locale} />
          <input type="hidden" name="fingerprint" value={draft.fingerprint} />
          <button className="primary-button" data-testid="whatsapp-open" disabled={offline}>{t("open")}</button>
        </form>
      </div> : null}
      {contact ? <details><summary>{t("editContact")}</summary>
        <form className="resource-form" onSubmit={(event) => {
          event.preventDefault(); setDraft(null); setContactStatus(null);
          const parsed = whatsappContactSchema.safeParse({ source, phone: contactPhone, locale: contactLocale });
          if (!parsed.success) { setContactStatus("invalidPhone"); return; }
          startTransition(async () => { try {
            const result = await whatsappContactAction(parsed.data); setContactStatus(result.ok ? "savedContact" : "unavailable");
            if (result.ok) { setContactPhone(parsed.data.phone ?? ""); setError(null); }
          } catch { setContactStatus("unavailable"); } });
        }}>
          <label className="field"><span>{t("guestPhone")}</span><input type="tel" autoComplete="tel" data-testid="whatsapp-contact-phone" disabled={pending} value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} /></label>
          <p>{t("phoneHint")}</p>
          <label className="field"><span>{t("contactLanguage")}</span><select data-testid="whatsapp-contact-locale" disabled={pending} value={contactLocale} onChange={(event) => setContactLocale(event.target.value as typeof contactLocale)}>
            {(["en", "fr", "ar"] as const).map((language) => <option key={language} value={language}>{t(`languages.${language}`)}</option>)}
          </select></label>
          <button type="submit" className="secondary-button" data-testid="whatsapp-contact-save" disabled={pending || offline}>{t("saveContact")}</button>
          {contactStatus ? <p role={contactStatus === "savedContact" ? "status" : "alert"}>{t(contactStatus)}</p> : null}
        </form>
      </details> : null}
    </>}
  </section>;
}
