"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import {
  contractorChoicesSchema, contractorSearchSchema, contractorWorkspaceSchema, maintenanceContractorChangeSchema
} from "../domain/contractor-sla";
import { maintenanceWorkOrderRequest, MaintenanceBrowserError, type MaintenanceBrowserState } from "./issue-browser";

type Workspace = z.infer<typeof contractorWorkspaceSchema>;
type Choices = z.infer<typeof contractorChoicesSchema>;
type Command = z.infer<typeof maintenanceContractorChangeSchema>;
const acknowledged = z.object({ recorded: z.literal(true) });

export function ContractorAssignmentPanel({ taskId, locale, scope, authorizationStamp }: {
  taskId: string; locale: AppLocale; scope: string; authorizationStamp: string;
}) {
  const t = useTranslations("MaintenanceIssues");
  const c = useTranslations("MaintenanceIssues.contractor");
  const operations = useTranslations("Operations.manage");
  const [view, setView] = useState<Workspace | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<MaintenanceBrowserState>("ready");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [saved, setSaved] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<Command | null>(null);
  const heading = useId();

  useEffect(() => () => controller.current?.abort(), []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState("loading");
    try {
      await work(abort.signal);
      if (!abort.signal.aborted) setState("ready");
    } catch (error) {
      if (abort.signal.aborted) return;
      const failure = error instanceof MaintenanceBrowserError ? error.state : "validation";
      setState(failure);
      if (failure === "forbidden" || failure === "offline" || failure === "conflict") {
        setView(null);
        setChoices(null);
        setSelected(null);
        pending.current = null;
      }
    }
  }

  function validate<T extends { authorizationStamp: string }>(response: T, signal: AbortSignal) {
    signal.throwIfAborted();
    if (response.authorizationStamp !== authorizationStamp) throw new MaintenanceBrowserError("conflict");
    return response;
  }

  async function load(signal: AbortSignal, cursor?: string) {
    const result = validate(contractorWorkspaceSchema.parse(
      await maintenanceWorkOrderRequest("contractor-read", { taskId, cursor }, signal, scope)), signal);
    setView(result);
  }

  function search(cursor?: string) {
    const input = contractorSearchSchema.safeParse({ taskId, query, cursor });
    if (!input.success) { setState("validation"); return; }
    setSelected(null);
    setSaved(false);
    void run(async signal => setChoices(validate(contractorChoicesSchema.parse(
      await maintenanceWorkOrderRequest("contractor-search", input.data, signal, scope)), signal)));
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = maintenanceContractorChangeSchema.safeParse({
      taskId, contractorId: clearing ? null : selected, expectedRevision: view?.revision,
      idempotencyKey: crypto.randomUUID(), reason: form.get("reason")
    });
    if (!input.success) { setState("validation"); return; }
    const last = pending.current;
    const command = last && last.expectedRevision === input.data.expectedRevision &&
      last.contractorId === input.data.contractorId && last.reason === input.data.reason ? last : input.data;
    pending.current = command;
    void run(async signal => {
      acknowledged.parse(await maintenanceWorkOrderRequest("contractor-publish", command, signal, scope));
      signal.throwIfAborted();
      pending.current = null;
      setChoices(null);
      setSelected(null);
      setClearing(false);
      setSaved(true);
      await load(signal);
    });
  }

  const busy = state === "loading";
  const localDate = (iso: string) => formatDateTime(locale, new Date(iso), { timeZone: view?.timeZone ?? "UTC" });
  return <section className="resource-form" aria-labelledby={heading}>
    <h4 id={heading}>{c("title")}</h4>
    {open ? <button type="button" className="quiet-button" onClick={() => {
      controller.current?.abort(); setOpen(false); setView(null); setChoices(null); setSelected(null);
      setClearing(false); setQuery(""); setSaved(false); setState("ready");
    }}>{c("close")}</button> : <button type="button" className="secondary-button" onClick={() => {
      setOpen(true); void run(signal => load(signal));
    }}>{c("open")}</button>}
    {open && busy ? <p role="status">{t("loading")}</p> : null}
    {open && state !== "ready" && !busy ? <div role="alert">
      <p>{t("states." + state)}</p>
      {view === null ? <button type="button" className="secondary-button" onClick={() => void run(signal => load(signal))}>{t("refresh")}</button> : null}
    </div> : null}
    {open && saved ? <p role="status">{c("saved")}</p> : null}
    {open && view ? <>
      {!view.history.length ? <p>{c("empty")}</p> : <ul className="resource-list">
        {view.history.map((item, index) => item.state === "MASKED" ? <li key={"masked:" + index}>{t("maskedSource")}</li> :
          <li key={item.revision} className="resource-form">
            {item.state === "CLEARED" ? <p>{c("cleared")}</p> : <>
              <p dir="auto">{item.contractor.label}</p>
              <p>{operations("priorities." + item.priority)}</p>
              <dl>
                <dt>{c("response")}</dt><dd>{localDate(item.response.dueAt)} · {c("milestones." + item.response.state)}</dd>
                <dt>{c("completion")}</dt><dd>{localDate(item.completion.dueAt)} · {c("milestones." + item.completion.state)}</dd>
              </dl>
              <p dir="auto">{item.reason}</p>
            </>}
            <p>{localDate(item.at)}</p>
          </li>)}
      </ul>}
      {view.next ? <div className="form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(signal => load(signal, view.next!))}>{t("next")}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(signal => load(signal))}>{t("first")}</button>
      </div> : null}
      {view.canChange && !view.policyAvailable ? <p role="status">{c("missingPolicy")}</p> : null}
      {view.canAssign && !clearing ? <form className="resource-form" onSubmit={event => { event.preventDefault(); search(); }}>
        <label className="field"><span>{c("search")}</span><input type="search" minLength={2} maxLength={120} required
          value={query} onChange={event => { setQuery(event.target.value); setChoices(null); setSelected(null); }}/></label>
        <button type="submit" disabled={busy} className="secondary-button">{t("search")}</button>
      </form> : null}
      {choices && !clearing ? <fieldset className="resource-form" disabled={busy}>
        <legend>{c("choices")}</legend>
        {choices.items.length ? choices.items.map(item => <label key={item.id}>
          <input type="radio" name={heading + "-contractor"} checked={selected === item.id} onChange={() => setSelected(item.id)}/>
          <span dir="auto">{item.label}</span>
        </label>) : <p>{t("emptyChoices")}</p>}
        {choices.next ? <button type="button" className="secondary-button" onClick={() => search(choices.next!)}>{t("next")}</button> : null}
      </fieldset> : null}
      {view.canClear ? <button type="button" className="quiet-button" disabled={busy} onClick={() => {
        setClearing(value => !value); setSelected(null); setSaved(false);
      }}>{c(clearing ? "cancel" : "clear")}</button> : null}
      {clearing || selected ? <form className="resource-form" onSubmit={save} data-testid="maintenance-contractor-form">
        <label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" minLength={6} maxLength={1000} required /></label>
        <button type="submit" className="primary-button" disabled={busy}>{c(clearing ? "confirmClear" : "assign")}</button>
      </form> : null}
    </> : null}
  </section>;
}
