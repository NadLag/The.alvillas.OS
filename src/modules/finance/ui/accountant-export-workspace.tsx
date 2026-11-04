"use client";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { AppLocale } from "@/i18n/routing";
import { accountantExportInputSchema, type AccountantReportKind, type AccountantExportFormat } from "../domain/accountant-export";
import { accountantEditorSchema, type AccountantExportEditor } from "../domain/accountant-export-editor";

type State = "ready" | "loading" | "sending" | "success" | "validation" | "forbidden" | "offline" | "configuration_unavailable" | "source_unavailable" | "conflict" | "capacity_exceeded" | "rate_limited" | "unavailable";
type Choice = AccountantExportEditor["choices"][number];
class ExportHttpError extends Error { constructor(readonly code: State) { super(code); } }
async function failure(response: Response): Promise<never> {
  if (response.status === 401 || response.status === 403) throw new ExportHttpError("forbidden");
  if (response.status === 429) throw new ExportHttpError("rate_limited");
  if (response.status === 400) throw new ExportHttpError("validation");
  const body: unknown = await response.json();
  if (body && typeof body === "object" && "error" in body && ["configuration_unavailable", "source_unavailable", "conflict", "capacity_exceeded"].includes(String(body.error))) throw new ExportHttpError(body.error as State);
  throw new ExportHttpError("unavailable");
}
async function editor(input: unknown, signal: AbortSignal) {
  const response = await fetch("/api/finance/accountant-exports/editor", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal });
  if (!response.ok) return failure(response); return accountantEditorSchema.parse(await response.json());
}

function NativeChoice({ kind, locale, currency, value, onChange, onDenied, disabled }: { kind: "property" | "owner" | "bank"; locale: AppLocale; currency: string;
  value: Choice | null; onChange: (choice: Choice | null) => void; onDenied: () => void; disabled: boolean }) {
  const t = useTranslations("AccountantExports"), id = useId(), generation = useRef(0), pending = useRef<AbortController | null>(null), [query, setQuery] = useState(""), [choices, setChoices] = useState<Choice[]>([]), [next, setNext] = useState<string | null>(null), [state, setState] = useState<State>("loading");
  useEffect(() => {
    const controller = new AbortController(), version = ++generation.current;
    const timer = setTimeout(() => { void editor({ locale, currency, choice: kind, query }, controller.signal).then(result => {
      if (controller.signal.aborted || version !== generation.current) return; setChoices(result.choices); setNext(result.next); setState("ready");
    }).catch(error => { if (controller.signal.aborted) return; setChoices([]); setNext(null); const code = error instanceof ExportHttpError ? error.code : "unavailable"; setState(code); if (code === "forbidden") onDenied(); }); }, 200);
    return () => { clearTimeout(timer); controller.abort(); pending.current?.abort(); };
  }, [locale, currency, kind, query, onDenied]);
  return <fieldset className="resource-form" disabled={disabled} data-testid={`accountant-${kind}-choices`}><legend>{t(kind)}</legend>
    <label className="field" htmlFor={id + "-search"}><span>{t("search")}</span><input id={id + "-search"} value={query} maxLength={120} dir="auto" onChange={event => { generation.current++; setQuery(event.target.value); setChoices([]); setNext(null); setState("loading"); }} /></label>
    <label className="field" htmlFor={id + "-selection"}><span>{t("selection")}</span><select id={id + "-selection"} data-testid={`accountant-${kind}-selection`} value={value?.id ?? ""} required={kind === "owner"} onChange={event => onChange(choices.find(choice => choice.id === event.target.value) ?? (value?.id === event.target.value ? value : null))}>
      <option value="">{t(kind === "owner" ? "chooseOwner" : "all")}</option>{value && !choices.some(choice => choice.id === value.id) ? <option value={value.id}>{value.label}</option> : null}{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
    </select></label>
    {state !== "ready" ? <p role={state === "loading" ? "status" : "alert"}>{t(state)}</p> : !choices.length ? <p role="status">{t("noResults")}</p> : null}
    {next ? <button type="button" className="secondary-button" disabled={state === "loading"} onClick={() => {
      const version = generation.current, controller = new AbortController(); pending.current?.abort(); pending.current = controller; setState("loading");
      void editor({ locale, currency, choice: kind, query, after: next }, controller.signal).then(result => { if (controller.signal.aborted || version !== generation.current) return; setChoices(previous => [...previous, ...result.choices]); setNext(result.next); setState("ready"); })
        .catch(error => { if (controller.signal.aborted || version !== generation.current) return; const code = error instanceof ExportHttpError ? error.code : "unavailable"; setState(code); if (code === "forbidden") onDenied(); });
    }}>{t("more")}</button> : null}
  </fieldset>;
}

export function AccountantExportWorkspace({ locale }: { locale: AppLocale }) {
  const t = useTranslations("AccountantExports"), [data, setData] = useState<AccountantExportEditor | null>(null), [state, setState] = useState<State>("loading"), [reload, setReload] = useState(0),
    [kind, setKind] = useState<AccountantReportKind>("TRANSACTIONS"), [format, setFormat] = useState<AccountantExportFormat>("CSV"), [currency, setCurrency] = useState(""),
    [fromOn, setFromOn] = useState(""), [toOn, setToOn] = useState(""), [reason, setReason] = useState(""), [property, setProperty] = useState<Choice | null>(null), [owner, setOwner] = useState<Choice | null>(null), [bank, setBank] = useState<Choice | null>(null),
    command = useRef<AbortController | null>(null), downloadUrl = useRef<string | null>(null);
  const wipe = useCallback(() => { command.current?.abort(); setData(null); setProperty(null); setOwner(null); setBank(null); setReason(""); if (downloadUrl.current) { URL.revokeObjectURL(downloadUrl.current); downloadUrl.current = null; } }, []);
  // Stable callback keeps independent selector requests from restarting when ordinary form fields change.
  const denied = useCallback(() => { wipe(); setState("forbidden"); }, [wipe]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => { if (!navigator.onLine) throw new ExportHttpError("offline"); return editor({ locale }, controller.signal); };
    void load().then(result => { if (controller.signal.aborted) return; setData(result); setKind(result.reports[0]); setFormat(result.formats[0]); setCurrency(result.currency); setFromOn(result.fromOn); setToOn(result.toOn); setState("ready"); })
      .catch(error => { if (!controller.signal.aborted) { setData(null); setState(error instanceof ExportHttpError ? error.code : "unavailable"); } });
    return () => controller.abort();
  }, [locale, reload]);
  useEffect(() => { const offline = () => { wipe(); setState("offline"); }; window.addEventListener("offline", offline); return () => { window.removeEventListener("offline", offline); command.current?.abort(); if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current); }; }, [wipe]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const filtered = ["TRANSACTIONS", "INCOME", "EXPENSES", "OWNER_STATEMENTS"].includes(kind), parsed = accountantExportInputSchema.safeParse({ kind, format, locale, currency, fromOn, toOn, reason,
      ...(filtered && property ? { propertyId: property.id } : {}), ...(kind === "OWNER_STATEMENTS" && owner ? { ownerId: owner.id } : {}), ...(kind === "BANK_RECONCILIATION" && bank ? { accountId: bank.id } : {}) });
    if (!parsed.success) { setState("validation"); return; } if (!navigator.onLine) { wipe(); setState("offline"); return; }
    const controller = new AbortController(); command.current?.abort(); command.current = controller; setState("sending");
    try {
      const response = await fetch("/api/finance/accountant-exports/download", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(parsed.data), signal: controller.signal });
      if (controller.signal.aborted) return; if (!response.ok) await failure(response);
      const extension = format === "EXCEL" ? "xlsx" : format.toLowerCase(), expected = format === "CSV" ? "text/csv" : format === "EXCEL" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf";
      const name = /filename="([^"]+)"/u.exec(response.headers.get("content-disposition") ?? "")?.[1];
      if (!response.headers.get("content-type")?.startsWith(expected) || !name || /[\\/]/u.test(name) || !name.endsWith("." + extension)) throw new ExportHttpError("unavailable");
      const blob = await response.blob(); if (controller.signal.aborted) return; if (downloadUrl.current) URL.revokeObjectURL(downloadUrl.current);
      const url = URL.createObjectURL(blob); downloadUrl.current = url; const link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setReason(""); setState("success");
      setTimeout(() => { URL.revokeObjectURL(url); if (downloadUrl.current === url) downloadUrl.current = null; }, 1000);
    } catch (error) { if (!controller.signal.aborted) { const code = error instanceof ExportHttpError ? error.code : navigator.onLine ? "unavailable" : "offline"; if (code === "forbidden" || code === "offline") wipe(); setState(code); } }
    finally { if (command.current === controller) command.current = null; }
  }
  if (!data) return <section className="resource-form"><p role={state === "loading" ? "status" : "alert"} data-testid="accountant-export-result">{t(state)}</p>{state !== "loading" ? <button type="button" className="secondary-button" onClick={() => { setState("loading"); setReload(value => value + 1); }}>{t("reload")}</button> : null}</section>;
  const busy = state === "sending", propertyEnabled = ["TRANSACTIONS", "INCOME", "EXPENSES", "OWNER_STATEMENTS"].includes(kind);
  return <form className="resource-form" onSubmit={event => { void submit(event); }} data-testid="accountant-export-form"><p>{t("calendar", { timezone: data.timezone })}</p>
    <fieldset className="form-grid" disabled={busy}><legend>{t("reportSettings")}</legend>
      <label className="field"><span>{t("report")}</span><select data-testid="accountant-report" value={kind} onChange={event => { setKind(event.target.value as AccountantReportKind); setState("ready"); }}>{data.reports.map(value => <option key={value} value={value}>{t(`reports.${value}`)}</option>)}</select></label>
      <label className="field"><span>{t("format")}</span><select data-testid="accountant-format" value={format} onChange={event => { setFormat(event.target.value as AccountantExportFormat); setState("ready"); }}>{data.formats.map(value => <option key={value} value={value} disabled={value === "PDF" && locale === "ar" && !data.arabicPdfAvailable}>{t(`formats.${value}`)}</option>)}</select></label>
      <label className="field"><span>{t("currency")}</span><select data-testid="accountant-currency" value={currency} onChange={event => { setCurrency(event.target.value); setBank(null); setState("ready"); }}>{data.currencies.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>{t("fromOn")}</span><input data-testid="accountant-from" type="date" required value={fromOn} onChange={event => setFromOn(event.target.value)} /></label>
      <label className="field"><span>{t("toOn")}</span><input data-testid="accountant-to" type="date" required min={fromOn} value={toOn} onChange={event => setToOn(event.target.value)} /></label>
    </fieldset>
    {propertyEnabled ? <NativeChoice kind="property" locale={locale} currency={currency} value={property} onChange={setProperty} onDenied={denied} disabled={busy} /> : <p>{t("noPropertyAllocation")}</p>}
    {kind === "OWNER_STATEMENTS" ? <NativeChoice kind="owner" locale={locale} currency={currency} value={owner} onChange={setOwner} onDenied={denied} disabled={busy} /> : null}
    {kind === "BANK_RECONCILIATION" ? <NativeChoice key={currency} kind="bank" locale={locale} currency={currency} value={bank} onChange={setBank} onDenied={denied} disabled={busy} /> : null}
    {locale === "ar" && !data.arabicPdfAvailable ? <p>{t("arabicPdfUnavailable")}</p> : null}
    <label className="field"><span>{t("reason")}</span><textarea data-testid="accountant-reason" value={reason} required minLength={6} maxLength={1000} dir="auto" disabled={busy} onChange={event => { setReason(event.target.value); setState("ready"); }} /></label>
    <button className="primary-button" type="submit" disabled={busy || format === "PDF" && locale === "ar" && !data.arabicPdfAvailable} data-testid="accountant-download">{t(busy ? "sending" : "download")}</button>
    {!["ready", "sending"].includes(state) ? <p role={state === "success" ? "status" : "alert"} data-testid="accountant-export-result">{t(state)}</p> : null}
  </form>;
}
