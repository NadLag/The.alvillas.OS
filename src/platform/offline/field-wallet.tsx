"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { liveQuery } from "dexie";
import { fieldWalletSnapshotSchema, type FieldWalletSnapshot } from "@/modules/identity/domain/field-wallet";
import { Money } from "@/platform/money/money";
import { formatCurrency, formatDateTime, formatNumber } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { fieldQueue, type FieldQueueScope } from "./field-queue";
import { resolveFieldScope } from "./field-session";
import { maskedValue } from "@/platform/authz/present";

export function FieldWallet({ scope, locale }: { scope: FieldQueueScope; locale: AppLocale }) {
  const t = useTranslations("FieldWallet");
  const [snapshot, setSnapshot] = useState<FieldWalletSnapshot | null>(null), [page, setPage] = useState(1), [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<"saved" | "unavailable" | "retry" | null>(null), [refresh, setRefresh] = useState(0);
  const { organizationId, userId } = scope;
  useEffect(() => {
    let disposed = false, busy = false, subscription: { unsubscribe(): void } | undefined;
    const owner = { organizationId, userId }, queue = fieldQueue();
    async function load() {
      if (busy || disposed) return; busy = true; setLoading(true);
      try {
        const verified = await resolveFieldScope(queue, navigator.onLine, owner);
        if (disposed) return;
        if (!verified) { setSnapshot(null); setNotice("unavailable"); return; }
        const saved = await queue.walletSnapshot(owner); if (!saved.incarnation) throw new Error("FIELD_SESSION_CHANGED");
        if (disposed) return;
        subscription ??= liveQuery(() => queue.walletSnapshot(owner)).subscribe({ next: value => {
          const parsed = fieldWalletSnapshotSchema.safeParse(value.wallet);
          if (!parsed.success || parsed.data.organizationId !== organizationId || parsed.data.userId !== userId) setSnapshot(null);
        }, error: () => setSnapshot(null) });
        const cached = fieldWalletSnapshotSchema.safeParse(saved.wallet);
        if (cached.success && cached.data.organizationId === organizationId && cached.data.userId === userId) setSnapshot(cached.data);
        if (!navigator.onLine) { setNotice(cached.success ? "saved" : "unavailable"); return; }
        const requestId = await queue.beginWalletRead(owner, saved.incarnation);
        const response = await fetch(`/api/field/wallet?page=${page}`, { credentials: "same-origin", cache: "no-store" });
        if (disposed) return;
        if ([401, 403, 404].includes(response.status)) {
          await queue.saveWalletSnapshot(owner, null, saved.incarnation, requestId); setSnapshot(null); setNotice("unavailable"); return;
        }
        if (!response.ok) throw new Error("FIELD_WALLET_UNAVAILABLE");
        const value = fieldWalletSnapshotSchema.parse(await response.json());
        if (disposed) return;
        if (!await queue.saveWalletSnapshot(owner, value, saved.incarnation, requestId)) throw new Error("FIELD_SESSION_CHANGED");
        setSnapshot(value); setNotice(null);
      } catch { if (!disposed) setNotice("retry"); }
      finally { busy = false; if (!disposed) setLoading(false); }
    }
    queueMicrotask(() => { if (!disposed) void load(); });
    const reload = () => { void load(); }; window.addEventListener("focus", reload); window.addEventListener("online", reload); window.addEventListener("offline", reload);
    return () => { disposed = true; subscription?.unsubscribe(); window.removeEventListener("focus", reload); window.removeEventListener("online", reload); window.removeEventListener("offline", reload); };
  }, [organizationId, userId, page, refresh]);
  const money = (amount: string, currency: string) => formatCurrency(locale, Money.of(amount, currency));
  const wallet = snapshot?.organizationId === organizationId && snapshot.userId === userId ? snapshot : null;
  return <section className="field-wallet" data-testid="field-wallet" aria-busy={loading}>
    {loading ? <p role="status">{t("loading")}</p> : null}
    {notice ? <p role="status" data-testid="field-wallet-notice">{t(notice)}</p> : null}
    {wallet ? <>
      <p data-testid="field-wallet-as-of">{t("asOf", { time: formatDateTime(locale, new Date(wallet.snapshotAt)) })}</p>
      <h2>{t("balance")}</h2><p>{t("heldDescription")}</p>
      {!wallet.linked ? <p>{t("unlinked")}</p> : <ul className="field-wallet-balances" data-testid="field-wallet-balances">{(wallet.balances.length ? wallet.balances : [{ amount: "0", currency: wallet.baseCurrency }]).map(balance =>
        <li key={balance.currency}><strong className="money" dir="auto">{money(balance.amount, balance.currency)}</strong></li>)}</ul>}
      <h2>{t("history")}</h2>
      {!wallet.movements.length ? <p data-testid="field-wallet-empty">{t("empty")}</p> : <ol className="field-wallet-movements">{wallet.movements.map(row => <li key={row.id} data-testid="field-wallet-movement">
        <div><strong dir="auto">{row.description ?? t("movement")}</strong><p dir="auto">{row.reference}</p><time dateTime={row.occurredAt}>{formatDateTime(locale, new Date(row.occurredAt))}</time></div>
        <div><strong className="money" dir="auto">{money(row.amount, row.currency)}</strong><p>{t(row.side === "DEBIT" ? "in" : "out")}</p></div>
      </li>)}</ol>}
      <nav className="form-actions" aria-label={t("history")}><button className="secondary-button" type="button" disabled={loading || wallet.page <= 1 || notice === "saved"} onClick={() => setPage(wallet.page - 1)} data-testid="field-wallet-previous">{t("previous")}</button>
        <span>{t("page", { page: wallet.page })}</span><button className="secondary-button" type="button" disabled={loading || !wallet.hasNext || notice === "saved"} onClick={() => setPage(wallet.page + 1)} data-testid="field-wallet-next">{t("next")}</button></nav>
      <h2>{t("compensation")}</h2>
      {!wallet.compensationVisible ? <p data-testid="field-wallet-compensation-masked">{maskedValue}</p> : !wallet.compensationTerms.length ? <p>{t("noCompensation")}</p> : <ul>{wallet.compensationTerms.map(term => <li key={term.id}>
        <strong className="money" dir="auto">{term.mode === "PERCENTAGE" ? t("percentage", { amount: formatNumber(locale, term.amount) }) : money(term.amount, term.currency)}</strong><p>{t(`mode.${term.mode}`)}</p><time dateTime={term.effectiveFrom}>{formatDateTime(locale, new Date(term.effectiveFrom))}</time>
      </li>)}</ul>}
    </> : null}
    <button className="secondary-button" type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)} data-testid="field-wallet-refresh">{t("refresh")}</button>
  </section>;
}
