"use client";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useTranslations } from "next-intl";
import type { z } from "zod";
import { SkeletonBlock } from "@/design-system/shells";
import { formatCurrencyAmount, formatDateTime } from "@/i18n/format";
import type { AppLocale } from "@/i18n/routing";
import { bankStatementImportInput, type bankStatementReviewInput } from "../domain/bank-statement";
import { bankStatementCommandReceiptSchema, bankStatementCommandRecoverySchema, type BankStatementCommandReceipt } from "../domain/bank-statement-command";
import { bankStatementAccountsSchema, bankStatementDetailSchema, bankStatementListSchema, bankStatementReviewSchema } from "../domain/bank-statement-workspace";
import { useCompensationRead } from "./use-compensation-read";
import { useCompensationCommand } from "./use-compensation-command";
import { companyExpenseFormText as text } from "./company-expense-form-text";

type Input = z.infer<typeof bankStatementImportInput>;
type Account = z.infer<typeof bankStatementAccountsSchema>["items"][number];
type Review = z.infer<typeof bankStatementReviewSchema>;
const endpoint = "/api/finance/bank-statements/read";
const recoveryInput = (idempotencyKey: string) => ({ idempotencyKey });
const statusPath = (id: string) => "/api/finance/bank-statements/status/" + encodeURIComponent(id);
const accept = (receipt: BankStatementCommandReceipt, input: Input | null, nonce: string | null) => receipt.idempotencyKey === nonce &&
  (!input || receipt.state !== "PENDING" || JSON.stringify(receipt.resumeInput) === JSON.stringify(input));

function FactRows({ lines, locale }: { lines: Review["lines"]; locale: AppLocale }) {
  const t = useTranslations("BankStatements");
  return <ol className="resource-list" data-testid="bank-source-lines">{lines.map(row => <li key={row.sourceOrder}>
    <p><span>{t("sourceRow", { number: row.sourceOrder })}</span> · <time dateTime={row.fact.postedDate ?? undefined}>{row.fact.postedDate ?? t("sourceCorrection")}</time></p>
    {row.fact.amount ? <p data-testid="bank-source-amount">{formatCurrencyAmount(locale, row.fact.amount.amount, row.fact.amount.currency)}</p> : null}
    {row.fact.name ? <p dir="auto">{row.fact.name}</p> : null}{row.fact.reference ? <p dir="auto">{row.fact.reference}</p> : null}
    {row.fact.correction ? <p>{t(`correction_${row.fact.correction.action}`, { reference: row.fact.correction.externalId })}</p> : null}
  </li>)}</ol>;
}
function History({ accountId, revision, locale, selected, onSelect, onInvalidate }: { accountId: string; revision: number; locale: AppLocale; selected: string | null; onSelect: (id: string) => void; onInvalidate: () => void }) {
  const t = useTranslations("BankStatements"), [before, setBefore] = useState<string | undefined>(), [afterOrder, setAfterOrder] = useState<number | undefined>();
  const list = useCompensationRead(endpoint, bankStatementListSchema, onInvalidate, JSON.stringify({ operation: "LIST", accountId, before }), revision);
  const detail = useCompensationRead(selected ? endpoint : null, bankStatementDetailSchema, onInvalidate, JSON.stringify({ operation: "DETAIL", importId: selected, afterOrder }), revision);
  return <section className="resource-form"><h2>{t("history")}</h2>
    {list.error ? <p role="alert">{t(list.error)}</p> : list.pending ? <SkeletonBlock rows={3}/> : <><ul data-testid="bank-import-list">{list.data?.items.map(item => <li key={item.id}><button className="secondary-button" type="button" data-testid="bank-import-open" onClick={() => { setAfterOrder(undefined); onSelect(item.id); }}>
      {t("importRows", { count: item.rowCount })} · {formatDateTime(locale, new Date(item.importedAt), { timeZone: "UTC" })}</button></li>)}</ul>{!list.data?.items.length ? <p>{t("empty")}</p> : null}
      <div className="form-actions">{before ? <button className="secondary-button" type="button" onClick={() => setBefore(undefined)}>{t("first")}</button> : null}{list.data?.next ? <button className="secondary-button" type="button" onClick={() => setBefore(list.data!.next!)}>{t("next")}</button> : null}</div></>}
    {selected ? detail.error ? <p role="alert">{t(detail.error)}</p> : detail.pending ? <SkeletonBlock rows={3}/> : detail.data ? <section className="resource-form" data-testid="bank-import-detail"><h3>{t("originalSource")}</h3>
      <p dir="auto">{detail.data.account.name} · {detail.data.account.lastFour}</p><p>{t("importRows", { count: detail.data.source.rowCount })}</p><p>{t("newRows", { count: detail.data.source.newRows })}</p><p>{t("reusedRows", { count: detail.data.source.reusedRows })}</p><p dir="auto">{detail.data.source.reason}</p>
      <FactRows locale={locale} lines={detail.data.lines}/><div className="form-actions">{afterOrder ? <button className="secondary-button" type="button" onClick={() => setAfterOrder(undefined)}>{t("first")}</button> : null}{detail.data.nextOrder ? <button className="secondary-button" type="button" data-testid="bank-lines-next" onClick={() => setAfterOrder(detail.data!.nextOrder!)}>{t("next")}</button> : null}</div>
    </section> : null : null}
  </section>;
}

function Upload({ account, locale, resume, state, fileRef, send, onInvalidate }: { account: Account; locale: AppLocale; resume: Input | null; state: string; fileRef: RefObject<File | null>; send: (input?: Omit<Input, "idempotencyKey">) => Promise<void>; onInvalidate: () => void }) {
  const t = useTranslations("BankStatements"), [format, setFormat] = useState<"CSV" | "OFX">(resume?.format ?? account.formats[0] ?? "CSV"), [source, setSource] = useState<z.infer<typeof bankStatementReviewInput> | null>(null), [review, setReview] = useState<Review | null>(null), [error, setError] = useState<string | null>(null), [pending, setPending] = useState(false), generation = useRef(0), controller = useRef<AbortController | null>(null);
  useEffect(() => () => { generation.current++; controller.current?.abort(); fileRef.current = null; }, [fileRef]);
  const ready = state === "ready", canResume = state === "pending" && !!resume && source?.fileSha256 === resume.fileSha256 && source.fileSize === resume.fileSize;
  return <section className="resource-form"><h2>{t(resume ? "resumeTitle" : "newImport")}</h2><p>{t("sourceHelp")}</p>
    <label className="field"><span>{t("format")}</span><select value={format} disabled={!ready || !!resume || pending} data-testid="bank-format" onChange={event => { setFormat(event.target.value as "CSV" | "OFX"); setReview(null); }}>{account.formats.map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
    <label className="field"><span>{t(resume ? "chooseOriginalFile" : "chooseFile")}</span><input type="file" accept=".csv,.ofx,text/csv,application/x-ofx,application/ofx" disabled={!["ready", "pending", "uncertain"].includes(state) || pending} data-testid="bank-file" onChange={event => {
      const own = ++generation.current, file = event.currentTarget.files?.[0]; controller.current?.abort(); fileRef.current = null; setReview(null); setSource(null); setError(null);
      if (!file || file.size < 1 || file.size > account.maxBytes) { setError("invalidFile"); return; }
      setPending(true); void file.arrayBuffer().then(bytes => crypto.subtle.digest("SHA-256", bytes)).then(hash => {
        if (own !== generation.current) return;
        const fileSha256 = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
        if (resume && (fileSha256 !== resume.fileSha256 || file.size !== resume.fileSize)) { setError("wrongOriginalFile"); return; }
        fileRef.current = file; setSource({ accountId: account.id, format: resume?.format ?? format, fileSha256, fileSize: file.size });
      }).catch(() => { if (own === generation.current) setError("invalidFile"); }).finally(() => { if (own === generation.current) setPending(false); });
    }}/></label>
    {pending ? <p role="status">{t("reading")}</p> : null}{error ? <p role="alert">{t(error)}</p> : null}
    {resume ? <><p>{t("resumeHelp")}</p><p dir="auto">{resume.reason}</p><button className="primary-button" type="button" disabled={!canResume || !account.canImport || pending} data-testid="bank-resume" onClick={() => { void send(); }}>{t("resume")}</button></> : <>
      <button className="secondary-button" type="button" disabled={!ready || !source || pending} data-testid="bank-review" onClick={() => {
        if (!source || !fileRef.current) return; const own = ++generation.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort; setPending(true); setError(null); setReview(null);
        const body = new FormData(); body.set("input", JSON.stringify({ ...source, format })); body.set("file", fileRef.current);
        void fetch("/api/finance/bank-statements/review", { method: "POST", credentials: "same-origin", cache: "no-store", body, signal: abort.signal }).then(async response => {
          if (own !== generation.current) return; if (response.status === 401 || response.status === 403) { onInvalidate(); return; } if (!response.ok) throw Error("unavailable");
          const value = bankStatementReviewSchema.parse(await response.json()); if (own === generation.current && value.account.id === account.id) setReview(value);
        }).catch(() => { if (own === generation.current) setError("unavailable"); }).finally(() => { if (own === generation.current) setPending(false); });
      }}>{t("review")}</button>
      {review && source ? <form className="resource-form" data-testid="bank-review-result" onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget); if (form.get("confirmed") !== "on" || !ready) return;
        void send({ ...source, format, reviewFingerprint: review.reviewFingerprint, reason: text(form.get("reason")) });
      }}><h3>{t("reviewTitle")}</h3><p>{t("importRows", { count: review.rowCount })}</p><p>{t("newRows", { count: review.newRows })}</p><p data-testid="bank-reused-rows">{t("reusedRows", { count: review.reusedRows })}</p>{review.reusedRows ? <p>{t("duplicateNotice")}</p> : null}<p dir="auto">{review.account.name} · {review.account.lastFour}</p><FactRows locale={locale} lines={review.lines}/>
        <label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={8} maxLength={2000} required disabled={!ready} data-testid="bank-reason"/></label>
        <label className="checkbox-field"><input type="checkbox" name="confirmed" required disabled={!ready} data-testid="bank-confirm"/>{t("confirm")}</label><button className="primary-button" disabled={!ready} data-testid="bank-submit">{t("import")}</button>
      </form> : null}</>}
  </section>;
}

export function BankStatementWorkspace({ locale, scope }: { locale: AppLocale; scope: string }) {
  const t = useTranslations("BankStatements"), [blocked, setBlocked] = useState(false), [accountId, setAccountId] = useState<string | null>(null), [selected, setSelected] = useState<string | null>(null), [resume, setResume] = useState<Input | null>(null), [revision, setRevision] = useState(0), fileRef = useRef<File | null>(null);
  const invalidate = useCallback(() => { fileRef.current = null; setBlocked(true); setAccountId(null); setSelected(null); setResume(null); }, []);
  const success = useCallback((receipt: BankStatementCommandReceipt) => { if (receipt.state === "SUCCEEDED") { setAccountId(receipt.accountId); setSelected(receipt.importId); setResume(null); fileRef.current = null; setRevision(value => value + 1); } }, []);
  const resumeInput = useCallback((receipt: BankStatementCommandReceipt) => { if (receipt.state !== "PENDING") return null; setResume(receipt.resumeInput); setAccountId(receipt.resumeInput.accountId); return receipt.resumeInput; }, []);
  const requestBody = useCallback((input: Input) => { if (!fileRef.current || fileRef.current.size !== input.fileSize) throw Error("Original source file required"); const body = new FormData(); body.set("input", JSON.stringify(input)); body.set("file", fileRef.current); return { body }; }, []);
  const command = useCompensationCommand({ storageKey: `alvillas:bank-statement:${scope}`, inputSchema: bankStatementImportInput, receiptSchema: bankStatementCommandReceiptSchema, recoverySchema: bankStatementCommandRecoverySchema,
    requestPath: "/api/finance/bank-statements/command", recoveryPath: "/api/finance/bank-statements/recover", recoveryInput, statusPath, requestBody, resumeInput, accept, onSuccess: success, onInvalidate: invalidate });
  const accounts = useCompensationRead(blocked ? null : endpoint, bankStatementAccountsSchema, invalidate, JSON.stringify({ operation: "ACCOUNTS" }), revision);
  const active = accounts.data?.items.find(account => account.id === accountId);
  if (blocked) return <section className="resource-form"><p role="alert">{t("privateUnavailable")}</p><button className="secondary-button" type="button" onClick={() => window.location.reload()}>{t("reload")}</button></section>;
  return <div className="resource-form"><section className="resource-form"><h2>{t("status")}</h2><p role="status" aria-live="polite" data-testid="bank-command-status">{t(`command_${command.state}`)}</p>
    {["uncertain", "recoveryUnavailable", "pending"].includes(command.state) ? <button className="secondary-button" type="button" data-testid="bank-recover" onClick={() => { void command.recover(); }}>{t("recover")}</button> : null}
    {command.state === "uncertain" ? <button className="secondary-button" type="button" onClick={() => { void command.send(); }}>{t("retryOriginal")}</button> : null}
    {command.state === "succeeded" ? <button className="secondary-button" type="button" data-testid="bank-command-next" onClick={() => { setSelected(null); command.startNew(); }}>{t("newImport")}</button> : null}
  </section><section className="resource-form"><h2>{t("accounts")}</h2>{accounts.error ? <p role="alert">{t(accounts.error)}</p> : accounts.pending ? <SkeletonBlock rows={3}/> : <><ul data-testid="bank-accounts">{accounts.data?.items.map(account => <li key={account.id}><button className="secondary-button" type="button" disabled={!["ready", "succeeded"].includes(command.state)} data-testid="bank-account-open" onClick={() => { fileRef.current = null; setSelected(null); setAccountId(account.id); }}><span dir="auto">{account.name} · {account.lastFour} · {account.currency}</span></button></li>)}</ul>{!accounts.data?.items.length ? <p>{t("noAccounts")}</p> : null}</>}</section>
    {active ? <><History key={active.id} accountId={active.id} locale={locale} revision={revision} selected={selected} onSelect={setSelected} onInvalidate={invalidate}/>{active.canImport && command.state !== "succeeded" ? <Upload key={active.id + ":" + revision + ":" + (resume ? "resume" : "new")} account={active} locale={locale} resume={resume} state={command.state} fileRef={fileRef} send={command.send} onInvalidate={invalidate}/> : null}</> : null}
  </div>;
}
