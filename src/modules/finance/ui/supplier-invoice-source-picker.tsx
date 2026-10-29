"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { getSupplierInvoiceChoicesAction } from "../application/supplier-invoice-actions";

export type InvoiceSourceOption = { id: string; label: string; description: string };
export function InvoiceSourcePicker({ kind, mode, value, propertyId, onChange }: { kind: "supplier" | "property" | "reservation"; mode: "create" | "edit"; value: InvoiceSourceOption | null; propertyId?: string; onChange: (value: InvoiceSourceOption | null) => void }) {
  const t = useTranslations("SupplierInvoices"), id = useId(), container = useRef<HTMLDivElement>(null), generation = useRef(0);
  const [query, setQuery] = useState(value?.label ?? ""), [open, setOpen] = useState(false), [options, setOptions] = useState<InvoiceSourceOption[]>([]), [next, setNext] = useState<string>(), [active, setActive] = useState(-1), [loading, setLoading] = useState(false), [error, setError] = useState<string | null>(null);
  const search = value?.label === query ? "" : query;
  useEffect(() => {
    if (!open) return;
    const version = ++generation.current;
    let disposed = false;
    const timer = setTimeout(() => {
      setLoading(true); setError(null);
      void getSupplierInvoiceChoicesAction({ kind, mode, propertyId, query: search }).then(result => {
        if (disposed || version !== generation.current) return;
        if (result.ok) { setOptions(result.data.options); setNext(result.data.next); setActive(-1); }
        else { setOptions([]); setNext(undefined); setError(result.code); }
      }).catch(() => { if (!disposed && version === generation.current) { setOptions([]); setError("error"); } }).finally(() => { if (!disposed && version === generation.current) setLoading(false); });
    }, 200);
    return () => { disposed = true; clearTimeout(timer); };
  }, [open, kind, mode, propertyId, search]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", close); return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  function select(option: InvoiceSourceOption | null) { generation.current++; setQuery(option?.label ?? ""); onChange(option); setOpen(false); setOptions([]); setNext(undefined); setError(null); }
  return <div className="field invoice-source-picker" ref={container}>
    <label htmlFor={id}>{t(kind)}</label>
    <input id={id} data-testid={`invoice-${kind}-picker`} value={query} dir="auto" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-options` : undefined} aria-activedescendant={open && active >= 0 && options[active] ? `${id}-option-${active}` : undefined} autoComplete="off" maxLength={160}
      onFocus={() => { setOptions([]); setLoading(true); setOpen(true); }} onChange={event => { generation.current++; setQuery(event.target.value); onChange(null); setOptions([]); setActive(-1); setLoading(true); setOpen(true); }}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); setActive(index => event.key === "ArrowDown" ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0)); }
        else if (event.key === "Enter" && open && active >= 0 && options[active]) { event.preventDefault(); select(options[active]); }
        else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
        else if (event.key === "Tab") setOpen(false);
      }} />
    {kind !== "supplier" && value ? <button className="quiet-button" type="button" onClick={() => select(null)}>{t(kind === "property" ? "company" : "noReservation")}</button> : null}
    {open ? <div className="invoice-source-popover"><ul role="listbox" id={`${id}-options`} aria-label={t(kind)} className="invoice-source-options">{options.map((option, index) => <li id={`${id}-option-${index}`} key={option.id} role="option" aria-selected={active === index} tabIndex={-1} onClick={() => select(option)}><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</li>)}</ul>
      <p role="status">{loading ? t("loading") : error ? t(error) : !options.length ? t("noResults") : null}</p>
      {next ? <button className="secondary-button" type="button" disabled={loading} onClick={() => {
        const version = generation.current; setLoading(true);
        void getSupplierInvoiceChoicesAction({ kind, mode, propertyId, query: search, after: next }).then(result => {
          if (version !== generation.current) return;
          if (result.ok) { setOptions(previous => [...previous, ...result.data.options]); setNext(result.data.next); } else { setOptions([]); setNext(undefined); setError(result.code); }
        }).catch(() => { if (version === generation.current) setError("error"); }).finally(() => { if (version === generation.current) setLoading(false); });
      }}>{t("more")}</button> : null}
    </div> : null}
  </div>;
}
