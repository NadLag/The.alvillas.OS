"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type { AppLocale } from "@/i18n/routing";
import { formatDateTime } from "@/i18n/format";
import { maintenanceIssueChoicesSchema } from "../domain/issue-context-view";
import { changeWorkOrderAssetSchema, workOrderAssetViewSchema } from "../domain/work-order-asset";
import { maintenanceIssueRequest, maintenanceWorkOrderRequest, MaintenanceBrowserError, type MaintenanceBrowserState } from "./issue-browser";

type View = z.infer<typeof workOrderAssetViewSchema>;
type Choices = z.infer<typeof maintenanceIssueChoicesSchema>;
const acknowledgement = z.object({ recorded: z.literal(true) });

export function WorkOrderAssetPanel({ taskId, issueId, locale, scope, authorizationStamp }: {
  taskId: string; issueId: string; locale: AppLocale; scope: string; authorizationStamp: string;
}) {
  const t = useTranslations("MaintenanceIssues");
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [selected, setSelected] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [removing, setRemoving] = useState(false);
  const [status, setStatus] = useState<MaintenanceBrowserState>("ready");
  const [saved, setSaved] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const last = useRef<{ hash: string; nonce: string } | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setStatus("loading");
    try {
      await work(abort.signal);
      if (!abort.signal.aborted) setStatus("ready");
    } catch (error) {
      if (abort.signal.aborted) return;
      const failure = error instanceof MaintenanceBrowserError ? error.state : "validation";
      setStatus(failure);
      if (["forbidden", "offline", "conflict"].includes(failure)) {
        setView(null); setChoices(null); setSelected(undefined); setRemoving(false);
      }
    }
  }

  function validate<T extends { authorizationStamp: string }>(value: T, signal: AbortSignal) {
    signal.throwIfAborted();
    if (value.authorizationStamp !== authorizationStamp) throw new MaintenanceBrowserError("conflict");
    return value;
  }

  async function load(signal: AbortSignal, before?: number) {
    setView(validate(workOrderAssetViewSchema.parse(await maintenanceWorkOrderRequest("assets-read", { taskId, before }, signal, scope)), signal));
  }

  function search(cursor?: string) {
    setSelected(undefined);
    setSaved(false);
    void run(async signal => setChoices(validate(maintenanceIssueChoicesSchema.parse(
      await maintenanceIssueRequest("sources", { issueId, kind: "ASSET", query, cursor }, signal, scope)), signal)));
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const pending = { taskId, assetId: removing ? null : selected, expectedRevision: view?.number, reason: new FormData(event.currentTarget).get("reason") };
    const hash = JSON.stringify(pending);
    if (last.current?.hash !== hash) last.current = { hash, nonce: crypto.randomUUID() };
    const command = changeWorkOrderAssetSchema.safeParse({ ...pending, idempotencyKey: last.current.nonce });
    if (!command.success) { setStatus("validation"); return; }
    void run(async signal => {
      acknowledgement.parse(await maintenanceWorkOrderRequest("assets-publish", command.data, signal, scope));
      signal.throwIfAborted();
      last.current = null;
      setSaved(true); setSelected(undefined); setRemoving(false); setChoices(null);
      await load(signal);
    });
  }

  const busy = status === "loading";
  return <section className="resource-form" aria-labelledby={id}>
    <h4 id={id}>{t("assetLink.title")}</h4>
    <button type="button" className="secondary-button" disabled={busy} onClick={() => {
      setOpened(true); setChoices(null); setSelected(undefined); setSaved(false); void run(signal => load(signal));
    }}>{t("assetLink.manage")}</button>
    {busy ? <p role="status">{t("states.loading")}</p> : null}
    {opened && status !== "ready" && !busy ? <p role="alert">{t("states." + status)}</p> : null}
    {saved ? <p role="status">{t("assetLink.saved")}</p> : null}
    {opened && view ? <>
      {view.current?.state === "LINKED" ? <Link className="secondary-button" href={"/" + locale + "/app/assets/" + view.current.assetId}>
        <span dir="auto">{view.current.tag} ? {view.current.label}</span>
      </Link> : <p>{t(view.current?.state === "MASKED" ? "maskedSource" : "assetLink.empty")}</p>}
      {view.canEdit && view.current?.state !== "MASKED" ? <>
        {!removing ? <form className="resource-form" onSubmit={event => { event.preventDefault(); search(); }}>
          <label className="field"><span>{t("assetLink.search")}</span><input type="search" maxLength={120} value={query}
            onChange={event => { setQuery(event.target.value); setChoices(null); setSelected(undefined); }} /></label>
          <button type="submit" className="secondary-button" disabled={busy}>{t("search")}</button>
        </form> : null}
        {!removing && choices ? <fieldset className="resource-form" disabled={busy}>
          <legend>{t("assetLink.link")}</legend>
          {choices.items.length ? choices.items.map(item => <label key={item.reference.id}><input type="radio" name={id + "-asset"}
            checked={selected === item.reference.id} onChange={() => setSelected(item.reference.id)} /> <span dir="auto">{item.label}</span></label>) : <p>{t("emptyChoices")}</p>}
          {choices.next ? <button type="button" className="secondary-button" onClick={() => search(choices.next ?? undefined)}>{t("next")}</button> : null}
        </fieldset> : null}
        {view.current?.state === "LINKED" ? <button type="button" className="quiet-button" disabled={busy} onClick={() => {
          setRemoving(value => !value); setSelected(undefined); setSaved(false);
        }}>{t(removing ? "changeReview" : "assetLink.remove")}</button> : null}
        {removing || selected ? <form className="resource-form" onSubmit={save}>
          <label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={6} maxLength={1000} required /></label>
          <button type="submit" className="primary-button" disabled={busy}>{t(removing ? "assetLink.remove" : "assetLink.link")}</button>
        </form> : null}
      </> : null}
      {view.items.length ? <details><summary>{t("history")}</summary><ol className="resource-list">
        {view.items.map((item, index) => <li key={item.state !== "MASKED" ? item.number : "masked:" + index}>
          {item.state === "MASKED" ? t("maskedSource") : <>
            <p>{formatDateTime(locale, new Date(item.at), { timeZone: "UTC" })}</p>
            {item.state === "LINKED" ? <p dir="auto">{item.tag} ? {item.label} ? {item.reason}</p> : <p>{t("assetLink.empty")}</p>}
          </>}
        </li>)}
      </ol>
      {view.next ? <button type="button" className="secondary-button" onClick={() => void run(signal => load(signal, view.next ?? undefined))}>{t("next")}</button> : null}
      </details> : null}
    </> : null}
  </section>;
}
