"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { signatureDistributionCommandSchema, signatureDistributionReviewSchema, signatureDistributionReceiptSchema, signatureDistributionRecoverySchema, signatureDistributionReconciliationSchema } from "../domain/document-signature-distribution";
import { clearDocumentNonce, documentRequest, DocumentBrowserError, readDocumentNonce, writeDocumentNonce, type DocumentBrowserState } from "./document-browser";

type Command = z.infer<typeof signatureDistributionCommandSchema>;
type Receipt = z.infer<typeof signatureDistributionReceiptSchema>;
type Review = { value: z.infer<typeof signatureDistributionReviewSchema>; reason: string };
export function DocumentSignatureDistributionPanel({ scope, preparationId, disabled, onForbidden }: { scope: string; preparationId: string | null; disabled: boolean; onForbidden: () => void }) {
  const t = useTranslations("SignatureDistribution"), a = useTranslations("DocumentArchive"), p = useTranslations("SignaturePreparation"), key = "alvillas:document-signature-distribution:" + scope;
  const [review, setReview] = useState<Review | null>(null), [reason, setReason] = useState(""), [receipt, setReceipt] = useState<Receipt | null>(null), [pending, setPending] = useState(false), [unrecorded, setUnrecorded] = useState(false),
    [canRetry, setCanRetry] = useState(false), [busy, setBusy] = useState(false), [state, setState] = useState<DocumentBrowserState>("ready");
  const live = useRef(false), running = useRef(false), requests = useRef(new Set<AbortController>()), nonce = useRef<string | null>(null), original = useRef<Command | null>(null);
  useEffect(() => {
    live.current = true; nonce.current = readDocumentNonce(key); const wipe = () => { for (const request of requests.current) request.abort(); requests.current.clear(); running.current = false; original.current = null; setReview(null); setReason(""); setReceipt(null); setCanRetry(false); setBusy(false); setUnrecorded(false); setPending(Boolean(nonce.current)); setState(navigator.onLine ? "ready" : "offline"); }, hidden = () => { if (document.visibilityState === "hidden") wipe(); };
    queueMicrotask(() => { if (live.current) wipe(); }); window.addEventListener("offline", wipe); window.addEventListener("pagehide", wipe); window.addEventListener("focus", wipe); document.addEventListener("visibilitychange", hidden); const active = requests.current;
    return () => { live.current = false; for (const request of active) request.abort(); active.clear(); original.current = null; window.removeEventListener("offline", wipe); window.removeEventListener("pagehide", wipe); window.removeEventListener("focus", wipe); document.removeEventListener("visibilitychange", hidden); };
  }, [key, preparationId]);
  const ask = async (path: string, input: unknown, signal: AbortSignal) => { const response = await documentRequest(scope, "signatures/distribution/" + path, input, signal), value: unknown = await response.json(); if (!live.current || signal.aborted) throw new DOMException("Aborted", "AbortError"); return value; };
  const perform = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (disabled || running.current) return; if (!navigator.onLine) { setState("offline"); return; } const controller = new AbortController(); requests.current.add(controller); running.current = true; setBusy(true); setState("loading");
    try { await work(controller.signal); } catch (error) { if (live.current && !controller.signal.aborted) { const code = error instanceof DocumentBrowserError ? error.state : error instanceof z.ZodError ? "validation" : nonce.current ? "uncertain" : "unavailable"; setState(code);
      if (code === "forbidden") { setReview(null); setReason(""); setReceipt(null); original.current = null; setCanRetry(false); onForbidden(); }
    } } finally { requests.current.delete(controller); if (live.current && !controller.signal.aborted) { running.current = false; setBusy(false); } }
  };
  const receive = (value: Receipt) => {
    if (value.idempotencyKey !== nonce.current || original.current && value.preparationId !== original.current.preparationId) throw new DocumentBrowserError("unavailable");
    setReceipt(value); setReview(null); setReason(""); setCanRetry(false); setUnrecorded(false); original.current = null;
    if (value.state === "SENT" || value.state === "SUPERSEDED") { clearDocumentNonce(key, value.idempotencyKey); nonce.current = null; setPending(false); } else setPending(true);
    setState(value.state === "SENT" ? "saved" : value.state === "UNCERTAIN" ? "uncertain" : value.state === "SOURCE_CHANGED" ? "conflict" : "ready");
  };
  const inspect = (event: FormEvent) => { event.preventDefault(); if (!preparationId) return; void perform(async signal => { if (reason.trim().length < 8) throw new DocumentBrowserError("validation"); const value = signatureDistributionReviewSchema.parse(await ask("review", { preparationId }, signal)); if (value.preparationId !== preparationId) throw new DocumentBrowserError("unavailable"); setReview({ value, reason: reason.trim() }); setReceipt(null); setState("ready"); }); };
  const send = () => { if (!review) return; void perform(async signal => { nonce.current ??= crypto.randomUUID(); writeDocumentNonce(key, nonce.current); setPending(true);
    const command = signatureDistributionCommandSchema.parse({ preparationId: review.value.preparationId, delivery: "EMAIL", idempotencyKey: nonce.current, reviewFingerprint: review.value.reviewFingerprint, reason: review.reason }); original.current = command; setCanRetry(true); receive(signatureDistributionReceiptSchema.parse(await ask("admit", command, signal)));
  }); };
  if (!preparationId && !pending && !receipt) return null;
  return <section className="resource-form" data-testid="signature-distribution"><h3>{t("title")}</h3><p>{t("guidance")}</p><p role="status" data-testid="signature-distribution-status">{a(busy ? "sending" : state)}</p>
    {state !== "forbidden" && state !== "offline" ? <>
      {receipt ? <p data-testid="signature-distribution-receipt">{t(receipt.state)}</p> : null}
      {pending ? <div className="resource-form"><p>{t("pending")}</p><button className="secondary-button" disabled={disabled || busy} data-testid="signature-distribution-recover" onClick={() => { void perform(async signal => { const value = signatureDistributionRecoverySchema.parse(await ask("recover", { idempotencyKey: nonce.current }, signal)); if (value.idempotencyKey !== nonce.current) throw new DocumentBrowserError("unavailable"); if (value.recorded) receive(value); else { setUnrecorded(true); setState("ready"); } }); }}>{t("recover")}</button>
        {receipt && ["ADMITTED", "UNCERTAIN"].includes(receipt.state) ? <button className="secondary-button" disabled={disabled || busy} data-testid="signature-distribution-reconcile" onClick={() => { void perform(async signal => { const value = signatureDistributionReconciliationSchema.parse(await ask("reconcile", { distributionId: receipt.id }, signal)); if (value.id !== receipt.id || value.signatureId !== receipt.signatureId || value.preparationId !== receipt.preparationId) throw new DocumentBrowserError("unavailable"); receive(signatureDistributionReceiptSchema.parse({ ...receipt, ...value })); }); }}>{t("reconcile")}</button> : null}
        {canRetry ? <button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform(async signal => { if (original.current) receive(signatureDistributionReceiptSchema.parse(await ask("admit", original.current, signal))); }); }}>{a("retryExact")}</button> : null}
        {unrecorded ? <><p>{a("unrecorded")}</p><button className="secondary-button" disabled={disabled || busy} onClick={() => { if (nonce.current) clearDocumentNonce(key, nonce.current); nonce.current = null; original.current = null; setPending(false); setCanRetry(false); setUnrecorded(false); setReview(null); }}>{t("newReview")}</button></> : null}
      </div> : null}
      {!pending && preparationId && receipt?.state !== "SENT" && receipt?.state !== "SUPERSEDED" ? <form className="resource-form" onSubmit={inspect}><label className="field"><span>{a("reason")}</span><textarea value={reason} minLength={8} maxLength={1000} required disabled={disabled || busy} onChange={event => { setReason(event.target.value); setReview(null); }} dir="auto" data-testid="signature-distribution-reason" /></label><button className="secondary-button" disabled={disabled || busy} data-testid="signature-distribution-review">{t("review")}</button></form> : null}
      {review && !pending ? <section className="resource-form" data-testid="signature-distribution-reviewed"><h4>{t("reviewed")}</h4><p dir="auto">{review.value.document.title}</p><p>{p("pages", { count: review.value.document.pageCount })}</p><p dir="auto">{review.value.signatureLevel}</p><ul className="resource-list">{review.value.recipients.map(recipient => { const role = review.value.recipientRoles.find(value => value.recipientId === recipient.id); return <li key={recipient.id} className="resource-form"><span dir="auto">{recipient.displayName} · {recipient.email}</span>{role ? <span>{p(role.role)} · {p("signingOrder")}: {role.signingOrder} · {p("fieldCount", { count: role.fieldCount })}</span> : null}</li>; })}</ul><p>{t("confirm")}</p><button className="primary-button" disabled={disabled || busy} data-testid="signature-distribution-send" onClick={send}>{t("send")}</button></section> : null}
    </> : null}
  </section>;
}
