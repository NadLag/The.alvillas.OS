"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { digestSaveAction, digestSettingsAction } from "./notification-actions";
import { digestSettingsSchema, type DigestSettings as Settings } from "./digest";
import type { digestSettings } from "./digest-service";

type Data = Awaited<ReturnType<typeof digestSettings>>;
export function DigestSettings() {
  const t = useTranslations("Notifications.digest"); const locale = useLocale();
  const [data, setData] = useState<Data | null>(null); const [draft, setDraft] = useState<Settings | null>(null);
  const [pending, startTransition] = useTransition(); const [offline, setOffline] = useState(false);
  const [error, setError] = useState<"loadError" | "saveError" | "invalid" | null>(null); const [saved, setSaved] = useState(false);
  const generation = useRef(0);
  const load = useCallback(() => {
    const request = ++generation.current;
    startTransition(async () => {
      setError(null);
      try { const result = await digestSettingsAction(); if (request !== generation.current) return;
        if (result.ok) { setData(result.data); setDraft(result.data.settings); } else setError("loadError");
      } catch { if (request === generation.current) setError("loadError"); }
    });
  }, []);
  useEffect(() => {
    const invalidate = () => { generation.current += 1; };
    load(); const network = () => setOffline(!navigator.onLine); queueMicrotask(network);
    const preferencesSaved = (event: Event) => {
      const email = (event as CustomEvent<{ enabled?: boolean; operations?: boolean }>).detail;
      setData((value) => value ? { ...value, emailEnabled: Boolean(email.enabled && email.operations) } : value);
    };
    window.addEventListener("notification-preferences-saved", preferencesSaved);
    window.addEventListener("online", network); window.addEventListener("offline", network);
    return () => { invalidate(); window.removeEventListener("notification-preferences-saved", preferencesSaved); window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, [load]);
  function change(patch: Partial<Settings>) { setSaved(false); setError(null); setDraft((value) => value ? { ...value, ...patch } : value); }
  function save() {
    const parsed = digestSettingsSchema.safeParse(draft);
    if (!parsed.success) { setError("invalid"); return; }
    startTransition(async () => {
      setError(null); setSaved(false);
      try { const result = await digestSaveAction(parsed.data); if (!result.ok) { setError("saveError"); return; }
        setDraft(result.data); setData((value) => value ? { ...value, settings: result.data, emailEnabled: result.data.frequency !== "off" || value.emailEnabled } : value); setSaved(true);
        if (result.data.frequency !== "off") window.dispatchEvent(new Event("digest-email-consent-saved"));
      } catch { setError("saveError"); }
    });
  }
  const dirty = Boolean(data && JSON.stringify(draft) !== JSON.stringify(data.settings));
  const format = (date: string) => new Intl.DateTimeFormat(locale, { timeZone: draft?.timezone && digestSettingsSchema.safeParse(draft).success ? draft.timezone : "UTC", dateStyle: "medium", timeStyle: "short" }).format(new Date(date));
  return <section className="notification-settings" data-testid="digest-settings" aria-labelledby="digest-heading" aria-busy={pending}>
    <h2 id="digest-heading">{t("title")}</h2><p>{t("description")}</p>
    {offline ? <p role="status">{t("offline")}</p> : null}
    {error ? <div role="alert"><p>{t(error)}</p>{error === "loadError" ? <button type="button" className="secondary-button" onClick={load} disabled={pending || offline}>{t("retry")}</button> : null}</div> : null}
    {!data && !error ? <><p role="status">{t("loading")}</p><SkeletonBlock rows={3} /></> : null}
    {draft && data ? <>
      {!data.available ? <p role="status">{t("unavailable")}</p> : null}
      {draft.frequency !== "off" && !data.emailEnabled ? <p role="status">{t("emailPaused")}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); save(); }}>
        <fieldset className="notification-channel" disabled={pending || offline || !data.available}>
          <legend>{t("schedule")}</legend>
          <div className="digest-grid">
            <label className="field">{t("frequency")}<select data-testid="digest-frequency" value={draft.frequency} onChange={(event) => change({ frequency: event.target.value as Settings["frequency"] })}>
              {(["off", "daily", "weekly"] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}
            </select></label>
            <label className="field">{t("language")}<select data-testid="digest-language" value={draft.language} onChange={(event) => change({ language: event.target.value as Settings["language"] })}>
              {(["en", "fr", "ar"] as const).map((value) => <option key={value} value={value}>{t(value)}</option>)}
            </select></label>
            <label className="field">{t("time")}<input data-testid="digest-time" type="time" required value={draft.time} onChange={(event) => change({ time: event.target.value })} /></label>
            <label className="field">{t("timezone")}<input data-testid="digest-timezone" required maxLength={100} value={draft.timezone} aria-describedby="digest-timezone-help" onChange={(event) => change({ timezone: event.target.value })} /><span className="notification-choice-description" id="digest-timezone-help">{t("timezoneHelp")}</span></label>
            {draft.frequency === "weekly" ? <label className="field">{t("weekday")}<select data-testid="digest-weekday" value={draft.weekday} onChange={(event) => change({ weekday: Number(event.target.value) })}>
              {[1, 2, 3, 4, 5, 6, 0].map((value) => <option key={value} value={value}>{new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + value)))}</option>)}
            </select></label> : null}
          </div>
          <label className="notification-choice"><input type="checkbox" data-testid="digest-quiet-enabled" checked={Boolean(draft.quietHours)} onChange={(event) => {
            // The server supplies the tenant's configured initial quiet interval.
            change({ quietHours: event.target.checked ? data.settings.quietHours ?? data.defaultQuietHours ?? { start: draft.time, end: draft.time } : null });
          }} /><span>{t("quietHours")}</span></label>
          {draft.quietHours ? <div className="digest-grid">
            <label className="field">{t("quietStart")}<input data-testid="digest-quiet-start" type="time" required value={draft.quietHours.start} onChange={(event) => change({ quietHours: { start: event.target.value, end: draft.quietHours!.end } })} /></label>
            <label className="field">{t("quietEnd")}<input data-testid="digest-quiet-end" type="time" required value={draft.quietHours.end} onChange={(event) => change({ quietHours: { start: draft.quietHours!.start, end: event.target.value } })} /></label>
          </div> : null}
          <p>{t("quietHelp")}</p>
        </fieldset>
        <div className="notification-save-bar"><p role="status" aria-live="polite">{saved ? t("saved") : dirty ? t("unsaved") : t("upToDate")}</p>
          <button className="primary-button" type="submit" data-testid="digest-save" disabled={pending || offline || !data.available || !dirty}>{t(pending ? "saving" : "save")}</button></div>
      </form>
      <h3>{t("history")}</h3>
      {data.history.length ? <ul className="digest-history">{data.history.map((row) => <li key={row.id}>
        <span>{format(row.scheduledAt ?? row.createdAt)}</span><strong>{t(`status.${row.status as "PENDING"}`)}</strong><span>{t("attempts", { count: row.attemptCount })}</span>
        {row.nextAttemptAt ? <span>{t("nextAttempt", { date: format(row.nextAttemptAt) })}</span> : null}
      </li>)}</ul> : <p>{t("empty")}</p>}
      <div className="digest-history-actions">
        <button className="secondary-button" type="button" data-testid="digest-history-refresh" disabled={pending || offline || dirty} onClick={load}>{t("refresh")}</button>
        {data.nextCursor ? <button className="secondary-button" type="button" disabled={pending || offline} onClick={() => startTransition(async () => {
          try { const result = await digestSettingsAction({ before: data.nextCursor }); if (result.ok) setData({ ...data, history: [...data.history, ...result.data.history], nextCursor: result.data.nextCursor }); else setError("loadError"); } catch { setError("loadError"); }
        })}>{t("more")}</button> : null}
      </div>
    </> : null}
  </section>;
}
