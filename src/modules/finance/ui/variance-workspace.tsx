"use client";
import { useCallback, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import type { VarianceSourceReference } from "../domain/variance-workflow";
import { varianceAssigneesSchema, varianceCommandInputSchema, varianceCommandReceiptSchema, varianceDetailSchema, varianceHistorySchema,
  type VarianceCommandReceipt } from "../domain/variance-workspace";
import { useCompensationRead } from "./use-compensation-read";
import { useCompensationCommand } from "./use-compensation-command";
import { companyExpenseFormText } from "./company-expense-form-text";

type Input = z.infer<typeof varianceCommandInputSchema>;
const endpoint = "/api/finance/variance-workflow/";

export function VarianceWorkspace({ locale, scope, actorId, source }: { locale: AppLocale; scope: string; actorId: string; source: VarianceSourceReference }) {
  const t = useTranslations("VarianceCenter"), [blocked, setBlocked] = useState(false), [revision, setRevision] = useState(0);
  const [showHistory, setShowHistory] = useState(false), [before, setBefore] = useState<string | undefined>();
  const [showAssignees, setShowAssignees] = useState(false), [after, setAfter] = useState<string | undefined>();
  const invalidate = useCallback(() => { setBlocked(true); setShowHistory(false); setShowAssignees(false); }, []);
  const success = useCallback(() => { setRevision(value => value + 1); setBefore(undefined); }, []);
  const recoveryInput = useCallback((idempotencyKey: string) => ({ source, idempotencyKey }), [source]);
  const accept = useCallback((receipt: VarianceCommandReceipt, input: Input | null, nonce: string | null) => receipt.idempotencyKey === nonce &&
    receipt.source.provider === source.provider && receipt.source.id === source.id && receipt.eventId === receipt.requestId &&
    receipt.intent.source.provider === source.provider && receipt.intent.source.id === source.id &&
    receipt.operation === receipt.intent.operation && BigInt(receipt.version) === BigInt(receipt.intent.version) + 1n &&
    (!input || JSON.stringify(receipt.intent) === JSON.stringify(input.intent)), [source]);
  const command = useCompensationCommand({ storageKey: "alvillas.variance-workflow.v1." + scope, inputSchema: varianceCommandInputSchema,
    receiptSchema: varianceCommandReceiptSchema, requestPath: endpoint + "command", recoveryPath: endpoint + "recover", recoveryInput, accept,
    onSuccess: success, onInvalidate: invalidate });
  const body = JSON.stringify({ source });
  const detail = useCompensationRead(blocked ? null : endpoint + "read", varianceDetailSchema, invalidate, body, revision);
  const history = useCompensationRead(!blocked && showHistory ? endpoint + "history" : null, varianceHistorySchema, invalidate, JSON.stringify({ source, before }), revision);
  const assignees = useCompensationRead(!blocked && showAssignees ? endpoint + "assignees" : null, varianceAssigneesSchema, undefined, JSON.stringify({ source, after }), revision);
  const data = detail.data, ready = command.state === "ready", writable = ready && Boolean(data && ["OPEN", "RESOLVED"].includes(data.status));
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!data || !writable) return;
    const form = new FormData(event.currentTarget), operation = companyExpenseFormText(form.get("operation")), reason = companyExpenseFormText(form.get("reason"));
    const base = { source, version: data.version, sourceFingerprint: data.sourceFingerprint, reason };
    if (operation === "ASSIGN") { const assignedTo = companyExpenseFormText(form.get("assignedTo")); void command.send({ intent: { ...base, operation, assignedTo: assignedTo || null } }); }
    else if (operation === "RESOLVE" || operation === "REOPEN") void command.send({ intent: { ...base, operation, action: companyExpenseFormText(form.get("action")) } });
  }
  const name = (id: string | null) => id === null ? t("unassigned") : id === actorId ? t("you") : assignees.data?.items.find(person => person.id === id)?.name ?? "••••••";
  if (blocked) return <section className="resource-form"><p role="alert">{t("privateUnavailable")}</p><button className="secondary-button" onClick={() => window.location.reload()}>{t("reload")}</button></section>;
  return <div className="resource-form" data-testid="variance-workspace">
    <section className="resource-form"><h2>{t("commandStatus")}</h2><p role="status" data-testid="variance-command-state">{t(`command_${command.state}`)}</p>
      {command.error ? <p role="alert">{t(command.error)}</p> : null}<div className="form-actions">
        {["uncertain", "recoveryUnavailable"].includes(command.state) ? <button className="secondary-button" onClick={() => { void command.recover(); }}>{t("recover")}</button> : null}
        {command.state === "uncertain" ? <button className="secondary-button" onClick={() => { void command.send(); }}>{t("retryExact")}</button> : null}
        {command.state === "succeeded" ? <button className="secondary-button" data-testid="variance-new-command" onClick={command.startNew}>{t("newCommand")}</button> : null}</div></section>
    {detail.pending ? <SkeletonBlock rows={5}/> : detail.error ? <p role="alert">{t(detail.error)}</p> : data ? <>
      <section className="resource-form" data-testid="variance-detail"><h2>{t(`provider_${source.provider}`)}</h2><p role="status" data-testid="variance-state">{t(`status_${data.status}`)}</p>
        <dl className="detail-grid">{(["expected", "actual", "variance"] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd data-testid={`variance-${key}`} dir="auto">{data.facts.kind === "MONEY" && data.facts.currency ?
          formatCurrencyAmount(locale, data.facts[key], data.facts.currency) : new Intl.NumberFormat(locale).format(BigInt(data.facts[key]))}</dd></div>)}
          <div><dt>{t("age")}</dt><dd>{t("ageDays", { days: new Intl.NumberFormat(locale).format(BigInt(data.ageMilliseconds) / 86_400_000n) })}</dd></div>
          <div><dt>{t("assignedTo")}</dt><dd dir="auto">{name(data.assignedTo)}</dd></div>
          {data.resolvedBy ? <div><dt>{t("resolvedBy")}</dt><dd dir="auto">{name(data.resolvedBy)}</dd></div> : null}
          {data.resolvedAt ? <div><dt>{t("resolvedAt")}</dt><dd>{formatDateTime(locale, new Date(data.resolvedAt), { timeZone: "UTC" })}</dd></div> : null}
        </dl>{data.facts.kind === "QUANTITY" ? <p dir="auto">{data.facts.unit.startsWith("QUANTITY:") ? data.facts.unit.slice(9) : t("quantity")}</p> : null}
        <p>{t("reason")}: <span dir="auto">{data.reason || t("empty")}</span></p><p>{t("action")}: <span dir="auto">{data.action || t("empty")}</span></p>
      </section>
      {["OPEN", "RESOLVED"].includes(data.status) ? <section className="resource-form"><h2>{t("review")}</h2><p>{t("reviewGuidance")}</p>
        {data.status === "OPEN" ? <form className="resource-form" key={`assign:${revision}:${data.version}`} onSubmit={submit}><fieldset className="resource-form" disabled={!writable}><legend>{t("assign")}</legend>
          <input type="hidden" name="operation" value="ASSIGN"/><label className="field"><span>{t("assignedTo")}</span><select name="assignedTo" defaultValue={data.assignedTo ?? ""} data-testid="variance-assignee">
            <option value="">{t("unassigned")}</option><option value={actorId}>{t("you")}</option>
            {data.assignedTo && data.assignedTo !== actorId && !assignees.data?.items.some(person => person.id === data.assignedTo) ? <option value={data.assignedTo}>{t("currentAssignee")}</option> : null}
            {assignees.data?.items.filter(person => person.id !== actorId).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <button type="button" className="secondary-button" onClick={() => setShowAssignees(true)}>{t("chooseColleague")}</button>
          {showAssignees && assignees.pending ? <SkeletonBlock rows={2}/> : null}{assignees.error ? <p role="status">{t("directoryUnavailable")}</p> : null}
          <div className="form-actions">{after ? <button type="button" className="secondary-button" onClick={() => setAfter(undefined)}>{t("first")}</button> : null}
            {assignees.data?.next ? <button type="button" className="secondary-button" onClick={() => setAfter(assignees.data!.next!)}>{t("next")}</button> : null}</div>
          <label className="field"><span>{t("reason")}</span><textarea name="reason" required minLength={6} maxLength={500} dir="auto" data-testid="variance-assignment-reason"/></label>
          <button className="secondary-button" data-testid="variance-assign">{t("assign")}</button></fieldset></form> : null}
        <form className="resource-form" key={`resolve:${revision}:${data.version}`} onSubmit={submit}><fieldset className="resource-form" disabled={!writable}>
          <legend>{t(data.status === "OPEN" ? "resolve" : "reopen")}</legend><input type="hidden" name="operation" value={data.status === "OPEN" ? "RESOLVE" : "REOPEN"}/>
          <label className="field"><span>{t("reason")}</span><textarea name="reason" required minLength={6} maxLength={500} dir="auto" data-testid="variance-reason"/></label>
          <label className="field"><span>{t("action")}</span><textarea name="action" required minLength={6} maxLength={500} dir="auto" data-testid="variance-action"/></label>
          <button className="primary-button" data-testid="variance-resolve">{t(data.status === "OPEN" ? "resolve" : "reopen")}</button></fieldset></form>
      </section> : null}
      <section className="resource-form"><h2>{t("history")}</h2><button type="button" className="secondary-button" onClick={() => setShowHistory(true)} data-testid="variance-show-history">{t("showHistory")}</button>
        {showHistory ? history.pending ? <SkeletonBlock rows={4}/> : history.error ? <p role="alert">{t(history.error)}</p> : <>
          {!history.data?.rows.length ? <p>{t("emptyHistory")}</p> : <ol className="resource-list" data-testid="variance-history">{history.data.rows.map(row => <li key={row.id}>
            <strong>{t(`operation_${row.operation}`)}</strong><p>{formatDateTime(locale, new Date(row.createdAt), { timeZone: "UTC" })} · <span dir="auto">{name(row.actorId)}</span></p>
            <p dir="auto">{row.reason}</p>{row.action ? <p dir="auto">{row.action}</p> : null}<p>{t("assignedTo")}: <span dir="auto">{name(row.assignedTo)}</span></p>
          </li>)}</ol>}<div className="form-actions">{before ? <button className="secondary-button" onClick={() => setBefore(undefined)}>{t("first")}</button> : null}
            {history.data?.next ? <button className="secondary-button" onClick={() => setBefore(history.data!.next!)}>{t("next")}</button> : null}</div></> : null}</section>
    </> : null}
  </div>;
}
