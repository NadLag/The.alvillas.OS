"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { normalizeAmountInput } from "@/platform/money/amount-input";
import { clearCommandNonce, readCommandNonce, writeCommandNonce } from "@/platform/http/command-nonce";
import {
  workOrderFinanceChoicesSchema, workOrderFinanceHistorySchema, workOrderFinanceIntentSchema,
  workOrderFinanceReviewSchema, workOrderFinanceSearchSchema, type WorkOrderFinanceIntent
} from "../domain/work-order-finance";
import { maintenanceWorkOrderRequest, MaintenanceBrowserError, type MaintenanceBrowserState } from "./issue-browser";

type History = z.infer<typeof workOrderFinanceHistorySchema>;
type Review = z.infer<typeof workOrderFinanceReviewSchema>;
type Detail = Review["detail"];
type Choices = z.infer<typeof workOrderFinanceChoicesSchema>;
const savedSchema = z.object({ recorded: z.boolean() });

function FinanceDetail({ detail, locale }: { detail: Detail; locale: AppLocale }) {
  const t = useTranslations("MaintenanceIssues.finance");
  const expenseStates = useTranslations("Expenses.states");
  const invoiceStates = useTranslations("SupplierInvoices.states");
  const amount = (money: { amount: string; currency: string }) => formatCurrencyAmount(locale, money.amount, money.currency);
  if (detail.kind !== "estimate") {
    const source = detail.source;
    const state = detail.kind === "expense" ? expenseStates : invoiceStates;
    const path = detail.kind === "expense" ? "expenses" : "finance/supplier-invoices";
    return <>
      <p dir="auto">{source.label}</p>
      <p className="money">{amount(source.money)}</p>
      <p>{state.has(source.state) ? state(source.state) : t("unknownState")}</p>
      <Link className="secondary-button" prefetch={false} href={"/" + locale + "/app/" + path + "/" + source.id}>{t("openSource")}</Link>
    </>;
  }
  return <>
    <h4>{t("estimateRevision", { revision: detail.revision })}</h4>
    <p dir="auto">{detail.fields.purpose}</p>
    <p className="money">{amount(detail.fields)}</p>
    <dl>
      <dt>{t("owner")}</dt><dd className="money">{amount(detail.allocation.owner)}</dd>
      <dt>{t("alvillas")}</dt><dd className="money">{amount(detail.allocation.alvillas)}</dd>
      <dt>{t("guest")}</dt><dd className="money">{amount(detail.allocation.guest)}</dd>
    </dl>
    <p>{detail.approvalSteps.length ? t("requiredApproval", {
      steps: new Intl.ListFormat(locale).format(detail.approvalSteps.map(step => t("steps." + step)))
    }) : t("noApproval")}</p>
    {detail.approval ? <>
      <p>{t("approvalStates." + detail.approval.state)}</p>
      <Link className="secondary-button" prefetch={false} href={"/" + locale + "/app/approvals/" + detail.approval.id}>{t("openApproval")}</Link>
    </> : null}
  </>;
}

/** A work-order row opens its private financial workspace on demand. */
export function WorkOrderFinancePanel({ taskId, locale, scope, authorizationStamp }: {
  taskId: string; locale: AppLocale; scope: string; authorizationStamp: string;
}) {
  const t = useTranslations("MaintenanceIssues");
  const f = useTranslations("MaintenanceIssues.finance");
  const panelId = useId();
  const [history, setHistory] = useState<History | null>(null);
  const [review, setReview] = useState<{ data: Review; intent: WorkOrderFinanceIntent } | null>(null);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [state, setState] = useState<MaintenanceBrowserState>("ready");
  const [notice, setNotice] = useState<"recorded" | "unknownOutcome" | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<WorkOrderFinanceIntent["kind"]>("estimate");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nonceKey = ["alvillas:maintenance-finance", scope, taskId].join(":");

  useEffect(() => () => abortRef.current?.abort(), []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setState("loading");
    try {
      await work(abort.signal);
      if (!abort.signal.aborted) setState("ready");
    } catch (error) {
      if (abort.signal.aborted) return;
      const failure = error instanceof MaintenanceBrowserError ? error.state : "validation";
      setState(failure);
      if (failure === "forbidden" || failure === "conflict" || failure === "offline") {
        setHistory(null);
        setReview(null);
        setChoices(null);
        setSelected(null);
      }
    }
  }

  function checked<T extends { authorizationStamp: string }>(value: T, signal: AbortSignal) {
    signal.throwIfAborted();
    if (value.authorizationStamp !== authorizationStamp) throw new MaintenanceBrowserError("conflict");
    return value;
  }

  async function load(signal: AbortSignal, cursor?: string) {
    const value = checked(workOrderFinanceHistorySchema.parse(
      await maintenanceWorkOrderRequest("finance-read", { taskId, cursor }, signal, scope)
    ), signal);
    setHistory(value);
    if (!value.canEstimate && value.canLink) setMode(current => current === "estimate" ? "expense" : current);
  }

  function openPanel() {
    setOpen(true);
    void run(async signal => {
      const nonce = readCommandNonce(nonceKey);
      if (nonce) {
        const outcome = savedSchema.parse(await maintenanceWorkOrderRequest(
          "finance-status", { taskId, idempotencyKey: nonce }, signal, scope
        ));
        signal.throwIfAborted();
        if (outcome.recorded) clearCommandNonce(nonceKey, nonce);
        setNotice(outcome.recorded ? "recorded" : "unknownOutcome");
      }
      await load(signal);
    });
  }

  function closePanel() {
    abortRef.current?.abort();
    setState("ready");
    setOpen(false);
    setHistory(null);
    setReview(null);
    setChoices(null);
    setSelected(null);
    setNotice(null);
    setQuery("");
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const { reason, amount, ...estimate } = fields;
    const input = workOrderFinanceIntentSchema.safeParse(mode === "estimate"
      ? { taskId, kind: mode, reason, expectedRevision: history?.latestRevision, fields: { ...estimate, amount: normalizeAmountInput(typeof amount === "string" ? amount : "") } }
      : { taskId, kind: mode, reason, sourceId: selected });
    if (!input.success) { setState("validation"); return; }
    setNotice(null);
    void run(async signal => {
      const data = checked(workOrderFinanceReviewSchema.parse(
        await maintenanceWorkOrderRequest("finance-review", input.data, signal, scope)
      ), signal);
      setReview({ data, intent: input.data });
    });
  }

  function search(cursor?: string) {
    if (mode === "estimate") return;
    const input = workOrderFinanceSearchSchema.safeParse({ taskId, kind: mode, query, cursor });
    if (!input.success) { setState("validation"); return; }
    setSelected(null);
    void run(async signal => {
      setChoices(checked(workOrderFinanceChoicesSchema.parse(
        await maintenanceWorkOrderRequest("finance-search", input.data, signal, scope)
      ), signal));
    });
  }

  function publish() {
    if (!review) return;
    void run(async signal => {
      const pending = readCommandNonce(nonceKey);
      if (pending) {
        const status = savedSchema.parse(await maintenanceWorkOrderRequest("finance-status", {
          taskId, idempotencyKey: pending
        }, signal, scope));
        signal.throwIfAborted();
        if (status.recorded) {
          clearCommandNonce(nonceKey, pending);
          setReview(null);
          setNotice("recorded");
          await load(signal);
          return;
        }
      }
      const idempotencyKey = pending ?? crypto.randomUUID();
      writeCommandNonce(nonceKey, idempotencyKey);
      const saved = savedSchema.parse(await maintenanceWorkOrderRequest(
        "finance-publish", { intent: review.intent, fingerprint: review.data.fingerprint, idempotencyKey }, signal, scope
      ));
      signal.throwIfAborted();
      if (saved.recorded) {
        clearCommandNonce(nonceKey, idempotencyKey);
        setReview(null);
        setChoices(null);
        setSelected(null);
        setNotice("recorded");
      }
      await load(signal);
    });
  }

  const busy = state === "loading";
  return <section aria-labelledby={panelId} className="resource-form">
    <h4 id={panelId}>{f("title")}</h4>
    {open ? <button type="button" onClick={closePanel} className="quiet-button">{f("close")}</button>
      : <button type="button" onClick={openPanel} className="secondary-button">{f("open")}</button>}
    {open && busy ? <div role="status" aria-label={t("loading")}><SkeletonBlock rows={3}/></div> : null}
    {open && state !== "ready" && !busy ? <div role="alert">
      <p>{t("states." + state)}</p>
      {history === null ? <button type="button" className="secondary-button" onClick={openPanel}>{f("refresh")}</button> : null}
    </div> : null}
    {open && notice ? <p role="status">{f(notice)}</p> : null}
    {open && history ? <>
      {history.items.length ? <ul className="resource-list">
        {history.items.map((row, index) => "masked" in row ? <li key={"masked:" + index}>{t("maskedSource")}</li> :
          <li className="resource-form" key={row.id}>
            <FinanceDetail detail={row.detail} locale={locale}/>
            <p dir="auto">{row.reason}</p>
            {row.recordedSourceVersion !== null ? <p className="money">{f("recordedVersion", {
              version: row.recordedSourceVersion,
              amount: formatCurrencyAmount(locale, row.recordedMoney.amount, row.recordedMoney.currency)
            })}</p> : null}
            <p>{formatDateTime(locale, new Date(row.recordedAt), { timeZone: "UTC" })}</p>
          </li>)}
      </ul> : <p>{f("empty")}</p>}
      {history.next ? <div className="form-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(signal => load(signal, history.next!))}>{t("next")}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => void run(signal => load(signal))}>{t("first")}</button>
      </div> : null}
      {!review && (history.canEstimate || history.canLink) ? <fieldset className="resource-form" disabled={busy}>
        <legend>{f("record")}</legend>
        <label className="field">
          <span>{f("kind")}</span>
          <select value={mode} onChange={event => {
            const value = event.target.value === "estimate" ? "estimate" : event.target.value === "expense" ? "expense" : "invoice";
            setMode(value); setChoices(null); setSelected(null); setQuery("");
          }}>
            <option value="estimate" disabled={!history.canEstimate}>{f("estimate")}</option>
            <option value="expense" disabled={!history.canLink}>{f("expense")}</option>
            <option value="invoice" disabled={!history.canLink}>{f("invoice")}</option>
          </select>
        </label>
        {mode !== "estimate" ? <form className="resource-form" onSubmit={event => { event.preventDefault(); search(); }}>
          <label className="field"><span>{f("sourceQuery")}</span>
            <input type="search" minLength={2} maxLength={120} required value={query} onChange={event => {
              setQuery(event.target.value); setChoices(null); setSelected(null);
            }}/>
          </label>
          <button type="submit" className="secondary-button">{t("search")}</button>
        </form> : null}
        {choices ? <fieldset className="resource-form">
          <legend>{f("choices")}</legend>
          {choices.items.length ? choices.items.map(source => <label key={source.id}>
            <input type="radio" name={panelId + "-source"} checked={selected === source.id} onChange={() => setSelected(source.id)}/>
            <span dir="auto">{source.label}</span>{" "}
            <span className="money">{formatCurrencyAmount(locale, source.money.amount, source.money.currency)}</span>
          </label>) : <p>{t("emptyChoices")}</p>}
          {choices.next ? <button type="button" className="secondary-button" onClick={() => search(choices.next!)}>{t("next")}</button> : null}
        </fieldset> : null}
        <form key={mode} onSubmit={prepare} className="resource-form" data-testid="maintenance-finance-form">
          {mode === "estimate" ? <>
            <label className="field"><span>{f("amount")}</span><input name="amount" inputMode="decimal" dir="ltr" maxLength={19} required /></label>
            <label className="field"><span>{f("currency")}</span><input name="currency" dir="ltr" autoCapitalize="characters" pattern="[A-Z]{3}" maxLength={3} required /></label>
            <label className="field"><span>{f("date")}</span><input name="occurredOn" type="date" required /></label>
            <label className="field"><span>{f("category")}</span><input name="category" dir="ltr" maxLength={120} required /></label>
            <label className="field"><span>{f("purpose")}</span><textarea name="purpose" dir="auto" minLength={6} maxLength={1000} required /></label>
          </> : null}
          <label className="field"><span>{t("reason")}</span><textarea name="reason" dir="auto" minLength={6} maxLength={1000} required /></label>
          <button type="submit" disabled={mode !== "estimate" && !selected} className="primary-button">{t("review")}</button>
        </form>
      </fieldset> : null}
      {review ? <div className="detail-panel resource-form" data-testid="maintenance-finance-review">
        <h3>{t("reviewTitle")}</h3>
        <FinanceDetail detail={review.data.detail} locale={locale}/>
        <button type="button" className="primary-button" disabled={busy} onClick={publish}>{f("save")}</button>
        <button type="button" className="quiet-button" disabled={busy} onClick={() => setReview(null)}>{t("changeReview")}</button>
      </div> : null}
    </> : null}
  </section>;
}
