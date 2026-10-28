"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { companyLedgerFilters } from "../domain/company-ledger";

export function CompanyLedgerFilters(props: { path: string; fromOn: string; toOn: string; currency: string; currencies: Array<{ code: string }>; timezone: string }) {
  const t = useTranslations("CompanyLedger"), router = useRouter(), [pending, startTransition] = useTransition(), [error, setError] = useState(false);
  return <form className="resource-form owner-ledger-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const parsed = companyLedgerFilters.safeParse(Object.fromEntries(["fromOn", "toOn", "currency", "timezone"].map(key => [key, data.get(key)])));
    if (!parsed.success) { setError(true); return; }
    setError(false);
    startTransition(() => router.push(props.path + "?" + new URLSearchParams(parsed.data).toString()));
  }}>
    {error ? <p role="alert">{t("invalidRange")}</p> : null}
    <fieldset disabled={pending}><legend>{t("filters")}</legend><div className="form-grid">
      <label className="field"><span>{t("currency")}</span><select name="currency" data-testid="company-ledger-currency" defaultValue={props.currency} required>{props.currencies.map(row => <option value={row.code} key={row.code}>{row.code}</option>)}</select></label>
      <label className="field"><span>{t("fromOn")}</span><input name="fromOn" data-testid="company-ledger-from" type="date" defaultValue={props.fromOn} required /></label>
      <label className="field"><span>{t("toOn")}</span><input name="toOn" data-testid="company-ledger-to" type="date" defaultValue={props.toOn} required /></label>
      <label className="field"><span>{t("timezone")}</span><input name="timezone" value={props.timezone} readOnly /></label>
    </div><div className="form-actions"><button className="primary-button" data-testid="company-ledger-apply" type="submit">{t(pending ? "loading" : "apply")}</button></div></fieldset>
  </form>;
}
