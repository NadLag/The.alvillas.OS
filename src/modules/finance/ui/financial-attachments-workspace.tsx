"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ZodError } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { formatCurrencyAmount } from "@/i18n/format";
import { financialAttachmentKinds, financialAttachmentIntentSchema, type FinancialAttachmentIntent } from "../domain/financial-attachment";
import { financialAttachmentEditorSchema, financialAttachmentHistorySchema, financialAttachmentAdmissionResultSchema,
  financialAttachmentItemSchema, type AttachmentTransaction, type FinancialAttachmentHistory, type FinancialAttachmentItem } from "../domain/financial-attachment-read-model";

type State = "ready" | "loading" | "sending" | "success" | "validation" | "forbidden" | "offline" | "configuration_unavailable" | "source_unavailable" | "conflict" | "rate_limited" | "storage_unavailable" | "unavailable";
class AttachmentHttpError extends Error { constructor(readonly state: State) { super(state); } }
async function request(endpoint: string, input: unknown, signal: AbortSignal) {
  const response = await fetch("/api/finance/attachments/" + endpoint, { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) return reject(response); return response;
}
async function reject(response: Response): Promise<never> {
  if (response.status === 401 || response.status === 403) throw new AttachmentHttpError("forbidden");
  if (response.status === 400) throw new AttachmentHttpError("validation");
  const data: unknown = await response.json();
  const state = data && typeof data === "object" && "error" in data ? String(data.error) : "unavailable";
  throw new AttachmentHttpError(["configuration_unavailable", "source_unavailable", "conflict", "rate_limited", "storage_unavailable"].includes(state) ? state as State : "unavailable");
}
export function FinancialAttachmentsWorkspace({ locale, initialTransactionId = "" }: { locale: AppLocale; initialTransactionId?: string }) {
  const t = useTranslations("FinancialAttachments"), [query, setQuery] = useState(""), [choices, setChoices] = useState<AttachmentTransaction[]>([]), [nextChoice, setNextChoice] = useState<string | null>(null),
    [transactionId, setTransactionId] = useState(initialTransactionId), [history, setHistory] = useState<FinancialAttachmentHistory | null>(null), [revision, setRevision] = useState(0),
    [kind, setKind] = useState<FinancialAttachmentIntent["kind"]>("RECEIPT"), [file, setFile] = useState<File | null>(null), [reason, setReason] = useState(""),
    [supersedes, setSupersedes] = useState<FinancialAttachmentItem | null>(null), [state, setState] = useState<State>("loading");
  const picker = useRef<HTMLInputElement | null>(null), command = useRef<AbortController | null>(null), generation = useRef(0),
    recovery = useRef<{ input: FinancialAttachmentIntent; admissionId?: string } | null>(null), privateRequests = useRef(new Set<AbortController>());
  const clearFile = useCallback(() => { setFile(null); recovery.current = null; if (picker.current) picker.current.value = ""; }, []);
  const wipe = useCallback(() => {
    generation.current++; for (const controller of privateRequests.current) controller.abort(); privateRequests.current.clear(); command.current?.abort();
    setChoices([]); setNextChoice(null); setHistory(null); setTransactionId(""); setSupersedes(null); setReason(""); clearFile();
  }, [clearFile]);
  const failed = useCallback((error: unknown) => {
    const code = navigator.onLine ? error instanceof AttachmentHttpError ? error.state : error instanceof ZodError ? "validation" : "unavailable" : "offline";
    if (code === "forbidden" || code === "offline") wipe(); if (code === "conflict") recovery.current = null; setState(code);
  }, [wipe]);
  useEffect(() => {
    const requests = privateRequests.current;
    const offline = () => { wipe(); setState("offline"); }, online = () => { setState("loading"); setRevision(value => value + 1); };
    window.addEventListener("offline", offline); window.addEventListener("online", online);
    return () => { window.removeEventListener("offline", offline); window.removeEventListener("online", online); for (const controller of requests) controller.abort(); command.current?.abort(); };
  }, [wipe]);
  useEffect(() => {
    const controller = new AbortController(), version = generation.current, requests = privateRequests.current; requests.add(controller);
    const timer = setTimeout(() => { if (!navigator.onLine) { failed(new AttachmentHttpError("offline")); return; }
      void request("editor", { query }, controller.signal).then(response => response.json()).then(value => financialAttachmentEditorSchema.parse(value)).then(result => {
        if (controller.signal.aborted || version !== generation.current) return; setChoices(result.items); setNextChoice(result.next); if (!transactionId) setState("ready");
      }).catch(error => { if (!controller.signal.aborted) failed(error); }).finally(() => requests.delete(controller)); }, 200);
    return () => { clearTimeout(timer); controller.abort(); requests.delete(controller); };
  }, [query, revision, failed, transactionId]);
  useEffect(() => {
    if (!transactionId) return; const controller = new AbortController(), version = generation.current, requests = privateRequests.current; requests.add(controller);
    void request("history", { transactionId }, controller.signal).then(response => response.json()).then(value => financialAttachmentHistorySchema.parse(value)).then(result => {
      if (controller.signal.aborted || version !== generation.current) return; setHistory(result); setState("ready");
    }).catch(error => { if (!controller.signal.aborted) { setHistory(null); failed(error); } }).finally(() => requests.delete(controller));
    return () => { controller.abort(); requests.delete(controller); };
  }, [transactionId, revision, failed]);
  const amount = (row: AttachmentTransaction) => row.amount !== null && row.currency ? formatCurrencyAmount(locale, row.amount, row.currency) : t("multipleCurrencies");
  const timestamp = (value: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!history || !file || !navigator.onLine || command.current) return;
    const controller = new AbortController(), version = generation.current; command.current = controller; setState("sending");
    try {
      if (!recovery.current) {
        const bytes = await file.arrayBuffer(), sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
        const parsed = financialAttachmentIntentSchema.parse({ transactionId, idempotencyKey: crypto.randomUUID(), kind, fileName: file.name,
          contentType: file.type, fileSize: file.size, sha256, supersedesId: supersedes?.id ?? null, reason });
        if (file.size > history.maxBytes || !history.contentTypes.includes(parsed.contentType)) throw new AttachmentHttpError("validation");
        if (controller.signal.aborted || version !== generation.current) return; recovery.current = { input: parsed };
      }
      const pending = recovery.current;
      if (!pending.admissionId) pending.admissionId = financialAttachmentAdmissionResultSchema.parse(await (await request("admit", pending.input, controller.signal)).json()).id;
      const response = await fetch("/api/finance/attachments/upload?id=" + encodeURIComponent(pending.admissionId), { method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { "Content-Type": "application/octet-stream" }, body: file, signal: controller.signal });
      if (!response.ok) await reject(response); financialAttachmentItemSchema.parse(await response.json());
      if (controller.signal.aborted || version !== generation.current) return;
      clearFile(); setReason(""); setSupersedes(null);
      const refreshed = financialAttachmentHistorySchema.parse(await (await request("history", { transactionId }, controller.signal)).json());
      if (!controller.signal.aborted && version === generation.current) { setHistory(refreshed); setState("success"); }
    } catch (error) { if (!controller.signal.aborted) failed(error); }
    finally { if (command.current === controller) command.current = null; }
  }
  async function download(row: FinancialAttachmentItem) {
    if (command.current || !navigator.onLine) return; const controller = new AbortController(), version = generation.current; command.current = controller; setState("sending");
    try {
      const response = await request("download", { id: row.id }, controller.signal), blob = await response.blob();
      if (controller.signal.aborted || version !== generation.current) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = row.fileName; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url); setState("ready");
    } catch (error) { if (!controller.signal.aborted) failed(error); } finally { if (command.current === controller) command.current = null; }
  }
  async function more(kind: "choices" | "history") {
    if (command.current || !navigator.onLine) return; const controller = new AbortController(), version = generation.current; command.current = controller; setState("loading");
    try {
      if (kind === "choices") { const data = financialAttachmentEditorSchema.parse(await (await request("editor", { query, before: nextChoice }, controller.signal)).json());
        if (!controller.signal.aborted && version === generation.current) { setChoices(previous => [...previous, ...data.items]); setNextChoice(data.next); } }
      else { const data = financialAttachmentHistorySchema.parse(await (await request("history", { transactionId, before: history?.next }, controller.signal)).json());
        if (!controller.signal.aborted && version === generation.current) setHistory(previous => previous ? { ...data, items: [...previous.items, ...data.items] } : data); }
      if (!controller.signal.aborted && version === generation.current) setState("ready");
    } catch (error) { if (!controller.signal.aborted) failed(error); } finally { if (command.current === controller) command.current = null; }
  }
  const busy = state === "sending" || state === "loading", blocked = state === "forbidden" || state === "offline";
  return <div className="resource-form" data-testid="financial-attachments-workspace">
    <fieldset className="resource-form" disabled={busy || blocked}><legend>{t("source")}</legend>
      <label className="field"><span>{t("search")}</span><input value={query} maxLength={120} dir="auto" data-testid="attachment-source-search" onChange={event => { setQuery(event.target.value); setChoices([]); setNextChoice(null); }} /></label>
      <label className="field"><span>{t("selection")}</span><select value={transactionId} data-testid="attachment-source-selection" onChange={event => { generation.current++; command.current?.abort(); command.current = null; setTransactionId(event.target.value); setHistory(null); setSupersedes(null); setReason(""); clearFile(); setState(event.target.value ? "loading" : "ready"); }}>
        <option value="">{t("chooseSource")}</option>{transactionId && !choices.some(row => row.id === transactionId) ? <option value={transactionId}>{history?.transaction.reference ?? t("selectedSource")}</option> : null}
        {choices.map(row => <option key={row.id} value={row.id}>{row.reference} · {amount(row)}</option>)}
      </select></label>
      {!choices.length && !busy ? <p>{t("noResults")}</p> : null}{nextChoice ? <button className="secondary-button" type="button" onClick={() => { void more("choices"); }}>{t("moreSources")}</button> : null}
    </fieldset>
    {history ? <><section className="resource-card"><h2>{history.transaction.reference}</h2><p className="money">{amount(history.transaction)}</p><p>{t("atUtc", { value: timestamp(history.transaction.occurredAt) })}</p></section>
      <form className="resource-form" onSubmit={event => { void submit(event); }} data-testid="attachment-upload-form"><fieldset className="resource-form" disabled={busy || blocked}><legend>{t("upload")}</legend>
        {supersedes ? <p>{t("replacing", { name: supersedes.fileName, version: supersedes.version })} <button type="button" className="secondary-button" onClick={() => { setSupersedes(null); clearFile(); }}>{t("cancelReplacement")}</button></p> : null}
        <label className="field"><span>{t("kind")}</span><select value={kind} disabled={Boolean(supersedes)} data-testid="attachment-kind" onChange={event => { recovery.current = null; setKind(event.target.value as FinancialAttachmentIntent["kind"]); }}>{financialAttachmentKinds.map(value => <option key={value} value={value}>{t(`kinds.${value}`)}</option>)}</select></label>
        <label className="field"><span>{t("file")}</span><input ref={picker} type="file" required accept={history.contentTypes.join(",")} data-testid="attachment-file" onChange={event => { recovery.current = null; setFile(event.target.files?.[0] ?? null); }} /></label><p>{t("limit", { count: history.maxBytes })}</p>
        <label className="field"><span>{t("reason")}</span><textarea value={reason} required minLength={6} maxLength={1000} dir="auto" data-testid="attachment-reason" onChange={event => { recovery.current = null; setReason(event.target.value); }} /></label>
        <button type="submit" className="primary-button" data-testid="attachment-submit" disabled={!file}>{t(state === "sending" ? "sending" : ["storage_unavailable", "unavailable"].includes(state) ? "resumeUpload" : "upload")}</button>
      </fieldset></form>
      <section className="resource-form" aria-label={t("history")}><h2>{t("history")}</h2><p>{t("historyGuidance")}</p>
        {!history.items.length ? <p role="status">{t("empty")}</p> : <ul className="owner-ledger-lines" data-testid="attachment-history">{history.items.map(row => <li className="resource-card" key={row.id} data-testid="attachment-history-item">
          <h3 dir="auto">{row.fileName}</h3><p>{t("version", { version: row.version })} · {t(`kinds.${row.kind}`)} · {t(row.supersededById ? "superseded" : "current")}</p>
          <p>{t("atUtc", { value: timestamp(row.createdAt) })}</p><p dir="auto">{row.reason}</p>
          <div className="button-row"><button type="button" className="secondary-button" disabled={busy || blocked} onClick={() => { void download(row); }}>{t("download")}</button>
            {!row.supersededById ? <button type="button" className="secondary-button" disabled={busy || blocked} onClick={() => { setSupersedes(row); setKind(row.kind); setReason(""); clearFile(); picker.current?.focus(); }}>{t("replace")}</button> : null}</div>
        </li>)}</ul>}{history.next ? <button type="button" className="secondary-button" disabled={busy || blocked} onClick={() => { void more("history"); }}>{t("moreHistory")}</button> : null}
      </section></> : null}
    {state !== "ready" ? <p role={["loading", "sending", "success"].includes(state) ? "status" : "alert"} data-testid="attachment-result">{t(state)}</p> : null}
    {state !== "loading" && state !== "sending" ? <button className="secondary-button" type="button" onClick={() => { setState(navigator.onLine ? "loading" : "offline"); setRevision(value => value + 1); }}>{t("reload")}</button> : null}
  </div>;
}
