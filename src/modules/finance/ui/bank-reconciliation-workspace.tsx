"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { bankStatementAccountsSchema } from "../domain/bank-statement-workspace";
import type { bankReconciliationMatchInput, bankReconciliationReleaseInput } from "../domain/bank-reconciliation";
import { bankReconciliationCommandInput, bankReconciliationCommandReceiptSchema, bankReconciliationCommandRecoverySchema, type BankReconciliationCommandReceipt } from "../domain/bank-reconciliation-command";
import { bankReconciliationHistorySchema, bankReconciliationDetailSchema } from "../domain/bank-reconciliation-workspace";
import { useCompensationRead } from "./use-compensation-read";
import { useCompensationCommand } from "./use-compensation-command";
import { companyExpenseFormText } from "./company-expense-form-text";
import { BankReconciliationEditor } from "./bank-reconciliation-editor";
import { BankReconciliationPlan } from "./bank-reconciliation-plan";

type Input = z.infer<typeof bankReconciliationCommandInput>;
type Draft = Omit<z.infer<typeof bankReconciliationMatchInput>, "idempotencyKey"> | Omit<z.infer<typeof bankReconciliationReleaseInput>, "idempotencyKey">;
const endpoint = "/api/finance/bank-reconciliation/read";
const recoveryInput = (idempotencyKey: string) => ({ idempotencyKey });
const statusPath = (id: string) => "/api/finance/bank-reconciliation/status/" + encodeURIComponent(id);
const accept = (receipt: BankReconciliationCommandReceipt, input: Input | null, nonce: string | null) => receipt.idempotencyKey === nonce && (!input ||
  receipt.operation === input.action && (input.action === "MATCH" ? receipt.result.accountId === input.accountId : receipt.result.originalId === input.id));

function History({ accountId, selected, locale, revision, ready, onSelect, onInvalidate, onCommand }: { accountId: string; selected: string | null; locale: AppLocale; revision: number; ready: boolean; onSelect: (id: string) => void; onInvalidate: () => void; onCommand: (draft: Draft) => void }) {
  const varianceText = useTranslations("VarianceCenter");
  const t = useTranslations("BankReconciliation"), [before, setBefore] = useState<string | undefined>();
  const history = useCompensationRead(endpoint, bankReconciliationHistorySchema, onInvalidate, JSON.stringify({ operation: "HISTORY", accountId, before }), revision);
  const detail = useCompensationRead(selected ? endpoint : null, bankReconciliationDetailSchema, onInvalidate, JSON.stringify({ operation: "DETAIL", id: selected }), revision);
  return <section className="resource-form"><h2>{t("history")}</h2>{history.error ? <p role="alert">{t(history.error)}</p> : history.pending ? <SkeletonBlock rows={3}/> : <>
    <ul className="resource-list" data-testid="bank-match-history">{history.data?.items.map(row => <li key={row.id}><button className="secondary-button" type="button" onClick={() => onSelect(row.id)} data-testid="bank-match-history-open" data-entry-id={row.id}>
      {t(`operation_${row.action}`)} · {formatDateTime(locale, new Date(row.createdAt), { timeZone: "UTC" })} · {t(`state_${row.state}`)}</button></li>)}</ul>{!history.data?.items.length ? <p>{t("empty")}</p> : null}
    <div className="form-actions">{before ? <button className="secondary-button" type="button" onClick={() => setBefore(undefined)}>{t("first")}</button> : null}{history.data?.next ? <button className="secondary-button" type="button" onClick={() => setBefore(history.data!.next!)}>{t("next")}</button> : null}</div></>}
    {selected ? detail.pending ? <SkeletonBlock rows={4}/> : detail.error ? <p role="alert">{t(detail.error)}</p> : detail.data ? <section className="resource-form" data-testid="bank-match-detail">
      <p role="status" data-testid="bank-match-source-state">{t(`state_${detail.data.state}`)}</p><BankReconciliationPlan plan={detail.data.plan} locale={locale}/>
      {detail.data.originalId ? <button className="secondary-button" type="button" onClick={() => onSelect(detail.data!.originalId!)}>{t("originalAssociation")}</button> :
        <Link className="secondary-button" prefetch={false} href={`/${locale}/app/finance/variances/BANK/${detail.data.id}`}>{varianceText("open")}</Link>}
      {detail.data.canRelease ? <form key={detail.data.id} className="resource-form" onSubmit={event => {
        event.preventDefault(); if (!ready || new FormData(event.currentTarget).get("confirmed") !== "on") return;
        onCommand({ action: "RELEASE", id: detail.data!.id, reason: companyExpenseFormText(new FormData(event.currentTarget).get("reason")) });
      }}><h3>{t("release")}</h3><p>{t("releaseGuidance")}</p><fieldset className="resource-form" disabled={!ready}>
        <legend className="sr-only">{t("release")}</legend><label className="field"><span>{t("reason")}</span><textarea name="reason" required minLength={8} maxLength={2000} dir="auto" data-testid="bank-match-release-reason"/></label>
        <label className="checkbox-field"><input type="checkbox" name="confirmed" required data-testid="bank-match-release-confirm"/>{t("confirmRelease")}</label>
        <button className="secondary-button" disabled={!ready} data-testid="bank-match-release">{t("release")}</button></fieldset></form> : null}
    </section> : null : null}
  </section>;
}

export function BankReconciliationWorkspace({ locale, scope }: { locale: AppLocale; scope: string }) {
  const t = useTranslations("BankReconciliation"), [blocked, setBlocked] = useState(false), [accountId, setAccountId] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [revision, setRevision] = useState(0);
  const invalidate = useCallback(() => { setBlocked(true); setAccountId(null); setSelected(null); }, []);
  const success = useCallback((receipt: BankReconciliationCommandReceipt) => { setAccountId(receipt.result.accountId); setSelected(receipt.result.id); setRevision(value => value + 1); }, []);
  const command = useCompensationCommand({ storageKey: `alvillas:bank-reconciliation:${scope}`, inputSchema: bankReconciliationCommandInput, receiptSchema: bankReconciliationCommandReceiptSchema, recoverySchema: bankReconciliationCommandRecoverySchema,
    requestPath: "/api/finance/bank-reconciliation/command", recoveryPath: "/api/finance/bank-reconciliation/recover", recoveryInput, statusPath, accept, onSuccess: success, onInvalidate: invalidate });
  const accounts = useCompensationRead(blocked ? null : "/api/finance/bank-statements/read", bankStatementAccountsSchema, invalidate, JSON.stringify({ operation: "ACCOUNTS" }), revision);
  const active = accounts.data?.items.find(account => account.id === accountId), ready = command.state === "ready";
  const send = (draft: Draft) => { void command.send(draft); };
  if (blocked) return <section className="resource-form"><p role="alert">{t("privateUnavailable")}</p><button className="secondary-button" onClick={() => window.location.reload()}>{t("reload")}</button></section>;
  return <div className="resource-form"><section className="resource-form"><h2>{t("status")}</h2><p role="status" data-testid="bank-match-command-state">{t(`command_${command.state}`)}</p>
    {command.error ? <p role="alert">{t(command.error)}</p> : null}<div className="form-actions">
      {["uncertain", "recoveryUnavailable"].includes(command.state) ? <button className="secondary-button" onClick={() => { void command.recover(); }} data-testid="bank-match-recover">{t("recover")}</button> : null}
      {command.state === "uncertain" ? <button className="secondary-button" onClick={() => { void command.send(); }}>{t("retryExact")}</button> : null}
      {command.state === "succeeded" ? <button className="secondary-button" onClick={command.startNew} data-testid="bank-match-new">{t("newCommand")}</button> : null}</div></section>
    <section className="resource-form"><h2>{t("accounts")}</h2>{accounts.error ? <p role="alert">{t(accounts.error)}</p> : accounts.pending ? <SkeletonBlock rows={3}/> : <>
      <ul className="resource-list" data-testid="bank-match-accounts">{accounts.data?.items.map(account => <li key={account.id}><button className="secondary-button" type="button" disabled={!["ready", "succeeded"].includes(command.state)} aria-pressed={active?.id === account.id} data-testid="bank-match-account" onClick={() => { if (command.state === "succeeded") command.startNew(); setSelected(null); setAccountId(account.id); }}>
        <span dir="auto">{account.name} · {account.lastFour} · {account.currency}</span></button></li>)}</ul>{!accounts.data?.items.length ? <p>{t("empty")}</p> : null}</>}</section>
    {active ? <><History key={active.id} accountId={active.id} selected={selected} locale={locale} revision={revision} ready={ready} onSelect={setSelected} onInvalidate={invalidate} onCommand={send}/>
      <BankReconciliationEditor key={active.id + ":" + revision} accountId={active.id} currency={active.currency} locale={locale} ready={ready} revision={revision} onInvalidate={invalidate} onMatch={send}/></> : null}
  </div>;
}
