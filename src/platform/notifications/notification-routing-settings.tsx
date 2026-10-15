"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { notificationRoutingAction, notificationRoutingSaveAction } from "./notification-actions";
import { notificationRoutingSaveSchema, routedNotificationKinds, type NotificationRouting, type RoutedNotificationKind } from "./notification-routing";

type Model = Extract<Awaited<ReturnType<typeof notificationRoutingAction>>, { ok: true }>["data"];
export function NotificationRoutingSettings() {
  const t = useTranslations("Notifications.routing");
  const kinds = useTranslations("Notifications.kinds");
  const [kind, setKind] = useState<RoutedNotificationKind>("task_assigned");
  const [propertyId, setPropertyId] = useState("");
  const [model, setModel] = useState<Model | null>(null);
  const [draft, setDraft] = useState<NotificationRouting | null>(null);
  const [reason, setReason] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState(false);
  const [saved, setSaved] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, startTransition] = useTransition();
  const generation = useRef(0);
  const load = useCallback(() => {
    const request = ++generation.current;
    startTransition(async () => {
      setDraft(null); setSaved(false); setError(false); setReason("");
      try {
        const response = await notificationRoutingAction({ kind, propertyId: propertyId || null });
        if (request !== generation.current) return;
        if (response.ok) { setModel(response.data); setDraft(response.data.routing); }
        else setError(true);
      } catch { if (request === generation.current) setError(true); }
    });
  }, [kind, propertyId]);
  useEffect(() => { load(); return () => { generation.current += 1; }; }, [load]);
  useEffect(() => {
    const network = () => setOffline(!navigator.onLine);
    queueMicrotask(network);
    window.addEventListener("online", network); window.addEventListener("offline", network);
    return () => { window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, []);
  function toggle(key: "roles" | "people", id: string, selected: boolean) {
    setSaved(false);
    setDraft((previous) => previous ? { ...previous, [key]: selected ? [...previous[key], id] : previous[key].filter((value) => value !== id) } : previous);
  }
  function save() {
    const input = notificationRoutingSaveSchema.safeParse({ kind, propertyId: propertyId || null, routing: draft, reason });
    if (!input.success) { setError(true); return; }
    startTransition(async () => {
      setError(false); setSaved(false);
      try {
        const response = await notificationRoutingSaveAction(input.data);
        if (response.ok) { setDraft(response.data); setSaved(true); setReason(""); }
        else setError(true);
      } catch { setError(true); }
    });
  }
  const identity = kind === "language_updated" || kind === "security_session_revoked";
  return <section className="notification-routing-settings" data-testid="notification-routing" aria-labelledby="notification-routing-title" aria-busy={pending}>
    <h2 id="notification-routing-title">{t("title")}</h2><p>{t("description")}</p>
    {offline ? <p aria-live="polite">{t("offline")}</p> : null}
    <fieldset className="notification-channel" disabled={pending || offline}>
      <legend>{t("eventScope")}</legend>
      <label className="field"><span>{t("event")}</span><select data-testid="routing-event" value={kind} onChange={(event) => setKind(event.target.value as RoutedNotificationKind)}>
        {routedNotificationKinds.map((value) => <option value={value} key={value}>{kinds(value)}</option>)}
      </select></label>
      <label className="field"><span>{t("scope")}</span><select data-testid="routing-scope" value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
        <option value="">{t("organization")}</option>
        {model?.properties.map((property) => <option key={property.id} value={property.id}>{property.name}</option>)}
      </select></label>
    </fieldset>
    {error ? <div role="alert"><p>{t("error")}</p>{!draft ? <button type="button" className="secondary-button" onClick={load} disabled={pending || offline}>{t("retry")}</button> : null}</div> : null}
    {!draft && !error ? <><p aria-live="polite">{t("loading")}</p><SkeletonBlock rows={3} /></> : null}
    {draft && model ? <form onSubmit={(event) => { event.preventDefault(); save(); }}>
      <p className="notification-policy">{identity ? t("securityPolicy") : t("scopePolicy")}</p>
      {!identity ? <fieldset className="notification-channel" disabled={pending || offline}>
        <legend>{t("recipients")}</legend>
        {kind !== "reservation_created" ? <label className="notification-choice"><input type="checkbox" data-testid="routing-assigned" checked={draft.assigned} onChange={(event) => { setSaved(false); setDraft({ ...draft, assigned: event.target.checked }); }} /><span>{t("assigned")}</span></label> : null}
        <label className="field"><span>{t("search")}</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <fieldset className="notification-channel"><legend>{t("roles")}</legend>
          {model.roles.filter((role) => role.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((role) => <label className="notification-choice" key={role.id}>
            <input type="checkbox" data-testid={`routing-role-${role.id}`} checked={draft.roles.includes(role.id)} onChange={(event) => toggle("roles", role.id, event.target.checked)} /><span>{role.name}</span>
          </label>)}
          {!model.roles.length ? <p>{t("empty")}</p> : null}
        </fieldset>
        <fieldset className="notification-channel"><legend>{t("people")}</legend>
          {model.people.filter((person) => person.displayName.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map((person) => <label className="notification-choice" key={person.id}>
            <input type="checkbox" data-testid={`routing-person-${person.id}`} checked={draft.people.includes(person.id)} onChange={(event) => toggle("people", person.id, event.target.checked)} /><span>{person.displayName}</span>
          </label>)}
          {!model.people.length ? <p>{t("empty")}</p> : null}
        </fieldset>
      </fieldset> : null}
      <fieldset className="notification-channel" disabled={pending || offline || kind === "security_session_revoked"}>
        <legend>{t("channels")}</legend>
        <label className="notification-choice"><input type="checkbox" data-testid="routing-in-app" checked={kind === "security_session_revoked" || draft.channels.includes("in_app")} onChange={(event) => { setSaved(false); setDraft({ ...draft, channels: event.target.checked ? ["in_app"] : [] }); }} /><span>{t("inApp")}</span></label>
        <p>{t("externalPending")}</p>
      </fieldset>
      <label className="field"><span>{t("reason")}</span><input data-testid="routing-reason" value={reason} onChange={(event) => setReason(event.target.value)} minLength={6} maxLength={500} required disabled={pending || offline} /></label>
      <div className="notification-routing-save-bar"><p aria-live="polite" data-testid="routing-status">{saved ? t("saved") : ""}</p>
        <button type="submit" className="primary-button" data-testid="routing-save" disabled={pending || offline || reason.trim().length < 6}>{t(pending ? "saving" : "save")}</button>
      </div>
    </form> : null}
  </section>;
}
