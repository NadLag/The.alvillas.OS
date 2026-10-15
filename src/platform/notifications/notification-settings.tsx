"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { notificationPreferencesAction, notificationPreferencesSaveAction } from "./notification-actions";
import { notificationPreferencesSchema, type NotificationPreferences } from "./notification-preferences";

export function NotificationSettings() {
  const t = useTranslations("Notifications.settings");
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [committed, setCommitted] = useState<NotificationPreferences | null>(null);
  const [error, setError] = useState<"load" | "save" | null>(null);
  const [saved, setSaved] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, startTransition] = useTransition();
  const generation = useRef(0);
  const load = useCallback(() => {
    const request = ++generation.current;
    startTransition(async () => {
      setError(null);
      try {
        const result = await notificationPreferencesAction();
        if (request !== generation.current) return;
        if (result.ok) { setDraft(result.data); setCommitted(result.data); }
        else setError("load");
      } catch { if (request === generation.current) setError("load"); }
    });
  }, []);
  useEffect(() => {
    load();
    const network = () => setOffline(!navigator.onLine);
    queueMicrotask(network);
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    return () => { generation.current += 1; window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, [load]);
  function change(key: "enabled" | "account" | "operations", checked: boolean) {
    setSaved(false); setError(null);
    setDraft((previous) => previous ? { ...previous, in_app: { ...previous.in_app, [key]: checked } } : previous);
  }
  function save() {
    const parsed = notificationPreferencesSchema.safeParse(draft);
    if (!parsed.success) { setError("save"); return; }
    startTransition(async () => {
      setError(null); setSaved(false);
      try {
        const result = await notificationPreferencesSaveAction(parsed.data);
        if (result.ok) { setDraft(result.data); setCommitted(result.data); setSaved(true); }
        else setError("save");
      } catch { setError("save"); }
    });
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(committed);
  return <div className="notification-settings" aria-busy={pending}>
    {offline ? <p role="status">{t("offline")}</p> : null}
    {error ? <div role="alert"><p>{t(error === "load" ? "loadError" : "saveError")}</p>
      {error === "load" ? <button className="secondary-button" type="button" onClick={load} disabled={pending || offline}>{t("retry")}</button> : null}</div> : null}
    {!draft && !error ? <div><p role="status">{t("loading")}</p><SkeletonBlock rows={3} /></div> : null}
    {draft ? <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <p id="notification-security-policy" className="notification-policy">{t("mandatory")}</p>
      <fieldset className="notification-channel" disabled={pending || offline}>
        <legend>{t("inApp")}</legend>
        <p>{t("inAppDescription")}</p>
        <label className="notification-choice"><input type="checkbox" data-testid="notification-in-app-enabled" checked={draft.in_app.enabled}
          onChange={(event) => change("enabled", event.target.checked)} /><span>{t("enabled")}</span></label>
        <div className="notification-categories">
          {(["account", "operations"] as const).map((category) => <label className="notification-choice" key={category}>
            <input type="checkbox" data-testid={`notification-${category}`} checked={draft.in_app[category]} disabled={!draft.in_app.enabled}
              onChange={(event) => change(category, event.target.checked)} /><span><strong>{t(category)}</strong><span className="notification-choice-description">{t(`${category}Description`)}</span></span>
          </label>)}
          <label className="notification-choice"><input type="checkbox" data-testid="notification-security-in-app" checked disabled aria-describedby="notification-security-policy" />
            <span><strong>{t("security")}</strong><span className="notification-choice-description">{t("securityDescription")}</span></span></label>
        </div>
      </fieldset>
      <fieldset className="notification-channel">
        <legend>{t("email")}</legend><p>{t("emailDescription")}</p>
        <label className="notification-choice"><input type="checkbox" data-testid="notification-security-email" checked disabled aria-describedby="notification-security-policy" />
          <span><strong>{t("security")}</strong><span className="notification-choice-description">{t("emailSecurityDescription")}</span></span></label>
      </fieldset>
      <div className="notification-save-bar">
        <p role="status" aria-live="polite">{saved ? t("saved") : dirty ? t("unsaved") : t("upToDate")}</p>
        <button className="primary-button" type="submit" data-testid="notification-preferences-save" disabled={pending || offline || !dirty}>{t(pending ? "saving" : "save")}</button>
      </div>
    </form> : null}
  </div>;
}
