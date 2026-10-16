"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { deliveryPageAction, deliveryLogsAction, deliveryRetryAction } from "./notification-actions";
import { deliveryRetrySchema } from "./delivery";
import type { deliveryPage, deliveryLogs } from "./delivery-service";

type Data = Awaited<ReturnType<typeof deliveryPage>>;
type Logs = Awaited<ReturnType<typeof deliveryLogs>>;
const channels = ["all", "email", "digest", "push"] as const;
const statuses = ["all", "PENDING", "ACCEPTED", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED", "SUPPRESSED", "NO_SUBSCRIPTION"] as const;
export function DeliverySettings() {
  const t = useTranslations("Notifications.delivery"); const locale = useLocale();
  const [data, setData] = useState<Data | null>(null); const [channel, setChannel] = useState<string>("all"); const [status, setStatus] = useState<string>("all");
  const [logs, setLogs] = useState<{ id: string; data: Logs } | null>(null); const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition(); const [offline, setOffline] = useState(false);
  const [error, setError] = useState(false); const [queued, setQueued] = useState(false); const generation = useRef(0);
  function load(more = false) {
    const request = ++generation.current;
    startTransition(async () => {
      setError(false); setQueued(false);
      try {
        const result = await deliveryPageAction({ channel, status, ...(more && data?.nextCursor ? { before: data.nextCursor } : {}) });
        if (request !== generation.current) return;
        if (result.ok) { setData(previous => more && previous ? { ...result.data, items: [...previous.items, ...result.data.items] } : result.data); if (!more) setLogs(null); }
        else setError(true);
      } catch { if (request === generation.current) setError(true); }
    });
  }
  // Filters reload from the first cursor; cursor changes from loading more do
  // not trigger an accidental reload. The latest generation owns the response.
  useEffect(() => {
    const request = ++generation.current; let cancelled = false;
    startTransition(async () => {
      setError(false); setData(null); setLogs(null);
      try { const result = await deliveryPageAction({ channel, status }); if (cancelled || request !== generation.current) return;
        if (result.ok) setData(result.data); else setError(true);
      } catch { if (request === generation.current) setError(true); }
    });
    return () => { cancelled = true; };
  }, [channel, status]);
  useEffect(() => {
    const network = () => setOffline(!navigator.onLine); queueMicrotask(network);
    window.addEventListener("online", network); window.addEventListener("offline", network);
    return () => { window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, []);
  const date = (value: string | null) => value ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : t("none");
  function details(id: string, more = false) {
    if (!more && logs?.id === id) { setLogs(null); return; }
    startTransition(async () => {
      setError(false); setReason("");
      try { const result = await deliveryLogsAction({ id, ...(more && logs?.data.nextCursor ? { before: logs.data.nextCursor } : {}) });
        if (result.ok) setLogs(previous => ({ id, data: more && previous?.id === id ? { ...result.data, items: [...previous.data.items, ...result.data.items] } : result.data })); else setError(true);
      } catch { setError(true); }
    });
  }
  function retry(id: string) {
    const input = deliveryRetrySchema.safeParse({ id, reason }); if (!input.success) { setError(true); return; }
    startTransition(async () => {
      setError(false); setQueued(false);
      try { const result = await deliveryRetryAction(input.data); if (result.ok) { setQueued(true); setReason(""); } else setError(true); }
      catch { setError(true); }
    });
  }
  return <section className="delivery-settings" data-testid="delivery-settings" aria-labelledby="delivery-heading" aria-busy={pending}>
    <h2 id="delivery-heading">{t("title")}</h2><p>{t("description")}</p><p className="notification-policy">{t("privacy")}</p>
    <div className="digest-grid">
      <label>{t("channel")}<select data-testid="delivery-channel" value={channel} onChange={event => setChannel(event.target.value)} disabled={pending || offline}>{channels.map(value => <option key={value} value={value}>{t(`channels.${value}`)}</option>)}</select></label>
      <label>{t("status")}<select data-testid="delivery-status" value={status} onChange={event => setStatus(event.target.value)} disabled={pending || offline}>{statuses.map(value => <option key={value} value={value}>{t(`statuses.${value}`)}</option>)}</select></label>
    </div>
    <div className="digest-history-actions"><button type="button" className="secondary-button" data-testid="delivery-refresh" disabled={pending || offline} onClick={() => load()}>{t("refresh")}</button></div>
    {offline ? <p role="status">{t("offline")}</p> : null}
    {error ? <p role="alert">{t("error")}</p> : null}
    {queued ? <p role="status">{t("queued")}</p> : null}
    {!data && !error ? <><p role="status">{t("loading")}</p><SkeletonBlock rows={3} /></> : null}
    {data?.items.length === 0 ? <p>{t("empty")}</p> : null}
    <ul className="delivery-list">{data?.items.map(row => <li key={row.id} data-testid="delivery-row" data-delivery-id={row.id}>
      <div className="delivery-row-heading"><h3>{t(`types.${row.kind}`)}</h3><span>{t(`channels.${row.channel}`)} · {t(`statuses.${row.status}`)}</span><time dateTime={row.createdAt}>{date(row.createdAt)}</time></div>
      <dl className="delivery-facts"><div><dt>{t("recipient")}</dt><dd>{row.recipient}</dd></div><div><dt>{t("attempts")}</dt><dd>{new Intl.NumberFormat(locale).format(row.attemptCount)}</dd></div>
        <div><dt>{t("providerStatus")}</dt><dd>{row.providerStatus ? new Intl.NumberFormat(locale, { useGrouping: false }).format(row.providerStatus) : t("none")}</dd></div>
        <div><dt>{t("outcome")}</dt><dd>{row.errorCode ? t(`codes.${row.errorCode}`) : t("none")}</dd></div>
        <div><dt>{t("nextAttempt")}</dt><dd>{date(row.nextAttemptAt)}</dd></div><div><dt>{t("deliveredAt")}</dt><dd>{date(row.deliveredAt)}</dd></div></dl>
      <button type="button" className="secondary-button" aria-expanded={logs?.id === row.id} aria-controls={`delivery-log-${row.id}`} disabled={pending || offline} onClick={() => details(row.id)}>{t("details")}</button>
      <div id={`delivery-log-${row.id}`} hidden={logs?.id !== row.id}>{logs?.id === row.id ? <>
        <p>{t("historyNote")}</p><ol className="delivery-log">{logs.data.items.map(log => <li key={log.id}><time dateTime={log.occurredAt}>{date(log.occurredAt)}</time> · {t(`outcomes.${log.outcome.replaceAll(".", "_")}`)}{log.attempt ? ` · ${t("attempts")}: ${new Intl.NumberFormat(locale).format(log.attempt)}` : ""}{log.providerStatus ? ` · ${t("httpStatus", { status: log.providerStatus })}` : ""}{log.code ? ` · ${t(`codes.${log.code}`)}` : ""}</li>)}</ol>
        {!logs.data.items.length ? <p>{t("legacy")}</p> : null}
        {logs.data.nextCursor ? <button type="button" className="secondary-button" disabled={pending || offline} onClick={() => details(row.id, true)}>{t("moreHistory")}</button> : null}
        {row.canRetry ? <form onSubmit={event => { event.preventDefault(); retry(row.id); }} className="delivery-retry"><label>{t("reason")}<input data-testid="delivery-reason" value={reason} onChange={event => setReason(event.target.value)} minLength={5} maxLength={500} required disabled={pending || offline} /></label><p>{t("retryPolicy")}</p><button type="submit" className="primary-button" data-testid="delivery-retry" disabled={pending || offline || reason.trim().length < 5}>{t("retry")}</button></form> : <p>{t("retryUnavailable")}</p>}
      </> : null}</div>
    </li>)}</ul>
    {data?.nextCursor ? <button type="button" className="secondary-button" data-testid="delivery-more" disabled={pending || offline} onClick={() => load(true)}>{t("more")}</button> : null}
  </section>;
}
