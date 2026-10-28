import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { safeLocale } from "@/i18n/routing";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { listSuppliers, SupplierAccessError } from "@/modules/finance/application/supplier-service";
import { supplierActor } from "@/modules/finance/ui/supplier-access";
export const dynamic = "force-dynamic";
export default async function Page({ params, searchParams }: { params: Promise<{ locale: string }>; searchParams: Promise<{ q?: string; category?: string; archived?: string; after?: string }> }) {
  const { locale: value } = await params, locale = safeLocale(value); setRequestLocale(locale);
  const t = await getTranslations("Suppliers"), query = await searchParams, actor = await supplierActor(locale); let result;
  try { result = await listSuppliers(actor, { query: query.q, category: query.category, includeArchived: query.archived === "1", after: query.after }); }
  catch (error) { if (error instanceof SupplierAccessError || error instanceof z.ZodError) notFound(); throw error; }
  const next = new URLSearchParams(); if (query.q) next.set("q", query.q); if (query.category) next.set("category", query.category); if (query.archived === "1") next.set("archived", "1"); if (result.next) next.set("after", result.next);
  return <AdminShell className="resource-page supplier-page" testId="suppliers-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("description")} actions={<>{result.canCreate ? <Link className="primary-button" data-testid="supplier-new" href={`/${locale}/app/finance/suppliers/new`}>{t("create")}</Link> : null}<Link className="secondary-button" href={`/${locale}/app`}>{t("backWorkspace")}</Link></>} />
    <form className="resource-form" method="get"><div className="form-grid"><label className="field"><span>{t("search")}</span><input type="search" name="q" data-testid="supplier-search" defaultValue={query.q} maxLength={120} /></label>
      <label className="field"><span>{t("category")}</span><input name="category" defaultValue={query.category} maxLength={80} /></label><label className="checkbox-field"><input type="checkbox" name="archived" value="1" defaultChecked={query.archived === "1"} /><span>{t("includeArchived")}</span></label></div>
      <div className="form-actions"><button className="secondary-button" type="submit" data-testid="supplier-search-apply">{t("searchAction")}</button></div></form>
    {!result.suppliers.length ? <p data-testid="suppliers-empty">{t("empty")}</p> : <ul className="resource-list">{result.suppliers.map(supplier => <li className="resource-card" data-testid="supplier-row" key={supplier.id}><h2>{supplier.displayName}</h2><p>{supplier.reference} · {supplier.category}</p>{supplier.archived ? <span className="status-badge">{t("archived")}</span> : null}<Link className="secondary-button" data-testid="supplier-open" href={`/${locale}/app/finance/suppliers/${supplier.id}`} prefetch={false}>{t("view")}</Link></li>)}</ul>}
    {result.next ? <Link className="secondary-button" href={`/${locale}/app/finance/suppliers?${next.toString()}`} prefetch={false}>{t("next")}</Link> : null}
  </AdminShell>;
}
