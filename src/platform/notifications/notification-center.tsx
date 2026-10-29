"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { usePathname, useRouter } from "next/navigation";
import { DesignDialog } from "@/design-system/radix-primitives";
import { EmptyState, SkeletonBlock } from "@/design-system/shells";
import { notificationOpenAction, notificationPageAction, notificationReadAction } from "./notification-actions";
import type { NotificationPage } from "./notification";
import { usePushLifecycle } from "./push-lifecycle";
import { whatsappComposerPath } from "./whatsapp-path";

export function NotificationCenter() {
  usePushLifecycle();
  const t = useTranslations("Notifications");
  const whatsapp = useTranslations("Whatsapp");
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [page, setPage] = useState<NotificationPage | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState(false);
  const [offline, setOffline] = useState(false);
  const [pending, startTransition] = useTransition();
  const generation = useRef(0);
  const refresh = useCallback(() => {
    const request = ++generation.current;
    startTransition(async () => {
      setError(false);
      try {
        const result = await notificationPageAction({});
        if (request !== generation.current) return;
        if (result.ok) setPage(result.data); else setError(true);
      } catch { if (request === generation.current) setError(true); }
    });
  }, []);
  useEffect(() => {
    refresh();
    const network = () => { setOffline(!navigator.onLine); if (navigator.onLine) refresh(); };
    const focus = () => { if (document.visibilityState === "visible" && navigator.onLine) refresh(); };
    queueMicrotask(() => setOffline(!navigator.onLine));
    window.addEventListener("online", network);
    window.addEventListener("offline", network);
    document.addEventListener("visibilitychange", focus);
    return () => {
      generation.current += 1;
      window.removeEventListener("online", network);
      window.removeEventListener("offline", network);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [refresh, pathname]);

  function more() {
    if (!page?.nextCursor) return;
    const cursor = page.nextCursor;
    const request = ++generation.current;
    startTransition(async () => {
      setError(false);
      try {
        const result = await notificationPageAction({ cursor });
        if (request !== generation.current) return;
        if (result.ok) setPage((previous) => ({ ...result.data, items: [...(previous?.items ?? []), ...result.data.items.filter((item) => !previous?.items.some((old) => old.id === item.id))] }));
        else setError(true);
      } catch { setError(true); }
    });
  }
  function act(id: string, open: boolean) {
    ++generation.current;
    startTransition(async () => {
      setError(false);
      try {
        // Recheck destination before mutating read state or navigating.
        const destination = open ? await notificationOpenAction(id, locale) : null;
        if (destination && !destination.ok) { setError(true); return; }
        const result = await notificationReadAction(id);
        if (!result.ok) { setError(true); return; }
        refresh();
        if (destination?.ok) { setDialogOpen(false); router.push(destination.data); }
      } catch { setError(true); }
    });
  }
  return (
    <DesignDialog title={t("title")} description={t("description")} closeLabel={t("close")} open={dialogOpen} onOpenChange={setDialogOpen}
      trigger={<button type="button" className="secondary-button notification-bell" data-testid="notification-bell"
        aria-label={page ? t("bellCount", { count: page.unreadCount }) : t("title")} onClick={refresh}>
        <Bell aria-hidden="true" size={20} />
        <span>{t("title")}</span>
        {page ? <span className="notification-count" data-testid="notification-count" aria-live="polite">{page.unreadCount.toLocaleString(locale)}</span> : null}
      </button>}>
      <div className="notification-panel" data-testid="notification-panel" aria-busy={pending} role="region" aria-label={t("title")} tabIndex={0}>
        <Link className="secondary-button" href={`/${locale}/app/notifications`} onClick={() => setDialogOpen(false)}>{t("settings.title")}</Link>
        {offline ? <p role="status">{t("offline")}</p> : null}
        {error ? <div role="alert"><p>{t("error")}</p><button className="secondary-button" type="button" onClick={refresh} disabled={pending || offline}>{t("retry")}</button></div> : null}
        {!page && pending ? <><p role="status">{t("loading")}</p><SkeletonBlock /></> : null}
        {page?.items.length === 0 ? <EmptyState tone="motif">{t("empty")}</EmptyState> : null}
        {page ? <ul className="notification-list" aria-label={t("title")}>
          {page.items.map((item) => <li key={item.id} className="notification-item" data-testid="notification-item" data-notification-id={item.id} data-read={Boolean(item.readAt)}>
            <div>
              <p className="notification-title">{t(`kinds.${item.kind}`)}</p>
              <time dateTime={item.createdAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.createdAt))}</time>
              <span className="notification-state">{t(item.readAt ? "read" : "unread")}</span>
              {item.resolution ? <span data-testid="notification-resolution">{t(`resolution.${item.resolution}`)}</span> : null}
            </div>
            {!item.available ? <p className="muted">{t("unavailable")}</p> : null}
            <div className="notification-actions">
              {item.available ? <button type="button" className="secondary-button" disabled={pending || offline} onClick={() => act(item.id, true)}>{t("open")}</button> : null}
              {item.available && ["reservation_created", "task_assigned", "task_completed"].includes(item.kind) ? <Link className="secondary-button" data-testid="notification-whatsapp" href={whatsappComposerPath(locale, { type: "notification", id: item.id })} onClick={() => setDialogOpen(false)}>{whatsapp("title")}</Link> : null}
              {!item.readAt ? <button type="button" className="secondary-button" disabled={pending || offline} onClick={() => act(item.id, false)}>{t("markRead")}</button> : null}
            </div>
          </li>)}
        </ul> : null}
        {page?.nextCursor ? <button type="button" className="secondary-button" data-testid="notification-more" onClick={more} disabled={pending || offline}>{t("more")}</button> : null}
      </div>
    </DesignDialog>
  );
}
