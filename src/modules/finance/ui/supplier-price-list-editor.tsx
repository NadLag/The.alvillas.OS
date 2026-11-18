"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import { saveSupplierPriceListAction } from "../application/supplier-price-list-action";

type Price = { code: string; name: string; unit: string; amount: string };
type List = { currency: string; items: Price[] };
const empty: Price = { code: "", name: "", unit: "", amount: "" };

export function SupplierPriceListEditor({ supplierId, version, initial }: { supplierId: string; version: number; initial: List | null }) {
  const t = useTranslations("Suppliers.prices"), router = useRouter();
  const [rows, setRows] = useState((initial?.items ?? [empty]).map((item, key) => ({ ...item, key })));
  const [nextKey, setNextKey] = useState(rows.length);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "invalid" | "forbidden" | "conflict" | "unavailable">("idle");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (key: string) => { const value = form.get(key); return typeof value === "string" ? value.trim() : ""; };
    const items = rows.map(({ code, name, unit, amount }) => ({ code, name, unit, amount: normalizeAmountInput(amount) }));
    setStatus("saving");
    try {
      const result = await saveSupplierPriceListAction({ supplierId, expectedVersion: version, effectiveOn: text("date"),
        reason: text("reason"), priceList: { currency: text("currency").toUpperCase(), items } });
      setStatus(result);
      if (result === "saved") router.refresh();
    } catch { setStatus("unavailable"); }
  }
  return <form className="resource-form" onSubmit={event => void submit(event)}>
    <fieldset className="resource-form" disabled={status === "saving"}>
      <legend>{t("newVersion")}</legend>
      <label className="field"><span>{t("effectiveOn")}</span><input type="date" name="date" required /></label>
      <label className="field"><span>{t("currency")}</span><input name="currency" dir="ltr" defaultValue={initial?.currency} maxLength={3} required /></label>
      {rows.map((row, index) => <fieldset className="resource-form" key={row.key}>
        <legend>{t("entry", { number: index + 1 })}</legend>
        {(["code", "name", "unit", "amount"] as const).map(key => <label className="field" key={key}>
          <span>{t(key)}</span>
          <input dir={key === "amount" || key === "code" ? "ltr" : "auto"} value={row[key]} inputMode={key === "amount" ? "decimal" : "text"}
            maxLength={{ code: 64, name: 160, unit: 80, amount: 19 }[key]} required
            onChange={event => { const value = event.target.value; setRows(items => items.map(item => item.key === row.key ? { ...item, [key]: value } : item)); }} />
        </label>)}
        {rows.length > 1 ? <button type="button" className="quiet-button" onClick={() => setRows(items => items.filter(item => item.key !== row.key))}>{t("remove")}</button> : null}
      </fieldset>)}
      {rows.length < 100 ? <button type="button" className="secondary-button" onClick={() => {
        setRows(items => [...items, { ...empty, key: nextKey }]); setNextKey(nextKey + 1);
      }}>{t("add")}</button> : null}
      <label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" minLength={6} maxLength={1000} required /></label>
      <button className="primary-button" type="submit">{t(status === "saving" ? "saving" : "save")}</button>
    </fieldset>
    {status === "saved" ? <p role="status">{t("saved")}</p> : null}
    {status !== "idle" && status !== "saving" && status !== "saved" ? <p role="alert">{t("errors." + status)}</p> : null}
  </form>;
}
