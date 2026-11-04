"use client";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { varianceCenterFilterSchema, varianceCenterPageSchema, type VarianceCenterFilter } from "../domain/variance-center";
import { useCompensationRead } from "./use-compensation-read";

export function VarianceCenter({ locale, actorId }: { locale: AppLocale; actorId: string }) {
  const t = useTranslations("VarianceCenter"), [filter, setFilter] = useState<VarianceCenterFilter>(() => varianceCenterFilterSchema.parse({ provider: "OTA" }));
  const [cursor, setCursor] = useState<string | undefined>(), [revision, setRevision] = useState(0);
  const page = useCompensationRead("/api/finance/variance-center/read", varianceCenterPageSchema, undefined, JSON.stringify({ ...filter, cursor }), revision);
  function change(key: keyof VarianceCenterFilter, value: string) {
    const parsed = varianceCenterFilterSchema.safeParse({ ...filter, [key]: value }); if (!parsed.success) return;
    setFilter(parsed.data); setCursor(undefined);
  }
  return <div className="resource-form" data-testid="variance-center">
    <section className="resource-form"><h2>{t("browse")}</h2><div className="resource-form">
      <label className="field"><span>{t("source")}</span><select value={filter.provider} onChange={event => change("provider", event.target.value)} data-testid="variance-center-provider">
        {(["OTA", "BANK", "STAFF", "INVENTORY"] as const).map(provider => <option value={provider} key={provider}>{t(`provider_${provider}`)}</option>)}</select></label>
      <label className="field"><span>{t("caseStatus")}</span><select value={filter.status} onChange={event => change("status", event.target.value)} data-testid="variance-center-status">
        {(["OPEN", "RESOLVED", "MATCHED", "SOURCE_CHANGED", "ALL"] as const).map(status => <option value={status} key={status}>{status === "ALL" ? t("allStatuses") : t(`status_${status}`)}</option>)}</select></label>
      <label className="field"><span>{t("assignment")}</span><select value={filter.assignment} onChange={event => change("assignment", event.target.value)} data-testid="variance-center-assignment">
        {(["ANY", "ME", "UNASSIGNED"] as const).map(assignment => <option value={assignment} key={assignment}>{t(`assignment_${assignment}`)}</option>)}</select></label>
    </div><button className="secondary-button" type="button" onClick={() => { setCursor(undefined); setRevision(value => value + 1); }}>{t("refresh")}</button></section>
    <section className="resource-form" aria-busy={page.pending} data-testid="variance-center-results"><h2>{t("differences")}</h2>
      {page.pending ? <SkeletonBlock rows={5}/> : page.error ? <p role="alert" data-testid="variance-center-error">{t(page.error === "forbidden" ? "queueForbidden" : page.error === "validation" ? "refreshRequired" : page.error)}</p> : <>
        {!page.data?.items.length ? <p role="status">{t("emptyPage")}</p> : <ul className="resource-list" data-testid="variance-center-items">{page.data.items.map(({ reference, detail }) => <li key={detail.source.provider + ":" + detail.source.id} data-testid="variance-center-item">
          <Link className="secondary-button variance-source-link" prefetch={false} href={`/${locale}/app/finance/variances/${detail.source.provider}/${detail.source.id}`} data-testid="variance-center-open"><span dir="auto">{reference}</span><span>{t("open")}</span></Link>
          <p>{t(`status_${detail.status}`)} · {t("ageDays", { days: new Intl.NumberFormat(locale).format(BigInt(detail.ageMilliseconds) / 86_400_000n) })}</p>
          <dl className="detail-grid">{(["expected", "actual", "variance"] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd dir="auto" data-testid={`variance-center-${key}`}>{
            detail.facts.kind === "MONEY" && detail.facts.currency ? formatCurrencyAmount(locale, detail.facts[key], detail.facts.currency) : new Intl.NumberFormat(locale).format(BigInt(detail.facts[key]))}</dd></div>)}</dl>
          {detail.facts.kind === "QUANTITY" ? <p dir="auto">{detail.facts.unit.startsWith("QUANTITY:") ? detail.facts.unit.slice(9) : t("quantity")}</p> : null}
          <p>{t("assignedTo")}: {detail.assignedTo === actorId ? t("you") : detail.assignedTo ? t("assignedColleague") : t("unassigned")}</p>
        </li>)}</ul>}
        <div className="form-actions">{cursor ? <button type="button" className="secondary-button" onClick={() => setCursor(undefined)} data-testid="variance-center-first">{t("first")}</button> : null}
          {page.data?.next ? <button type="button" className="secondary-button" onClick={() => setCursor(page.data!.next!)} data-testid="variance-center-next">{t("next")}</button> : null}</div>
      </>}
    </section>
  </div>;
}
