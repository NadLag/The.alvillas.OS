"use client";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { signedArchiveCommandSchema, signedArchiveReviewSchema, signedArchiveReconciliationReceiptSchema, type signedArchiveReceiptSchema } from "../domain/document-signed-archive";
import { documentRequest, DocumentBrowserError, readDocumentNonce, writeDocumentNonce, clearDocumentNonce, type DocumentBrowserState } from "./document-browser";

type Command = z.infer<typeof signedArchiveCommandSchema>;
type Receipt = z.infer<typeof signedArchiveReceiptSchema>;
export function DocumentSignedArchivePanel({ scope, signatureId, disabled, onForbidden, onOpen }: { scope: string; signatureId: string; disabled: boolean; onForbidden: () => void; onOpen: (documentId: string) => void }) {
  const t = useTranslations("SignedArchive"), a = useTranslations("DocumentArchive"), key = "alvillas:document-signed-archive:" + scope + ":" + signatureId;
  const [review, setReview] = useState<z.infer<typeof signedArchiveReviewSchema> | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null), [reason, setReason] = useState(""), [pending, setPending] = useState(false), [unrecorded, setUnrecorded] = useState(false), [canRetry, setCanRetry] = useState(false), [busy, setBusy] = useState(false), [state, setState] = useState<DocumentBrowserState>("ready");
  const live = useRef(false), running = useRef(false), nonce = useRef<string | null>(null), original = useRef<Command | null>(null), requests = useRef(new Set<AbortController>());
  useEffect(() => { live.current = true; nonce.current = readDocumentNonce(key); const wipe = () => { for (const request of requests.current) request.abort(); requests.current.clear(); running.current = false; original.current = null; setReview(null); setReceipt(null); setReason(""); setCanRetry(false); setUnrecorded(false); setBusy(false); setPending(Boolean(nonce.current)); setState(navigator.onLine ? "ready" : "offline"); }, hidden = () => { if (document.visibilityState === "hidden") wipe(); };
    queueMicrotask(() => { if (live.current) wipe(); }); window.addEventListener("focus", wipe); window.addEventListener("offline", wipe); window.addEventListener("pagehide", wipe); document.addEventListener("visibilitychange", hidden); const active = requests.current;
    return () => { live.current = false; for (const request of active) request.abort(); active.clear(); original.current = null; window.removeEventListener("focus", wipe); window.removeEventListener("offline", wipe); window.removeEventListener("pagehide", wipe); document.removeEventListener("visibilitychange", hidden); };
  }, [key]);
  const ask = async (path: string, input: unknown, signal: AbortSignal) => { const response = await documentRequest(scope, "signatures/archive/" + path, input, signal), value: unknown = await response.json(); if (!live.current || signal.aborted) throw new DOMException("Aborted", "AbortError"); return value; };
  const perform = async (work: (signal: AbortSignal) => Promise<void>) => { if (disabled || running.current) return; if (!navigator.onLine) { setState("offline"); return; } const controller = new AbortController(); requests.current.add(controller); running.current = true; setBusy(true); setState("loading");
    try { await work(controller.signal); } catch (error) { if (live.current && !controller.signal.aborted) { const code = error instanceof DocumentBrowserError ? error.state : error instanceof z.ZodError ? "validation" : nonce.current ? "uncertain" : "unavailable"; setState(code); if (code === "forbidden") { setReview(null); setReceipt(null); setReason(""); original.current = null; setCanRetry(false); onForbidden(); } } }
    finally { requests.current.delete(controller); if (live.current && !controller.signal.aborted) { running.current = false; setBusy(false); } }
  };
  const clear = () => { if (nonce.current) clearDocumentNonce(key, nonce.current); nonce.current = null; original.current = null; setPending(false); setCanRetry(false); setUnrecorded(false); };
  const receive = (raw: unknown) => { const value = signedArchiveReconciliationReceiptSchema.parse(raw); if (value.idempotencyKey !== nonce.current || value.receipt && value.receipt.signatureId !== signatureId) throw new DocumentBrowserError("unavailable");
    if (!value.recorded && !value.receipt) { setUnrecorded(true); setState("ready"); return; } setReceipt(value.receipt); setReview(null); setReason(""); clear(); setState(value.receipt?.state === "COMPLETE" ? "saved" : "ready"); };
  const inspect = () => { void perform(async signal => { const value = signedArchiveReviewSchema.parse(await ask("review", { signatureId }, signal)); if (value.signatureId !== signatureId) throw new DocumentBrowserError("unavailable"); setReview(value); setReceipt(value.receipt); setState("ready"); }); };
  const reconcile = () => { if (!review) return; void perform(async signal => { if (reason.trim().length < 8) throw new DocumentBrowserError("validation"); nonce.current ??= crypto.randomUUID(); writeDocumentNonce(key, nonce.current); setPending(true); const command = signedArchiveCommandSchema.parse({ signatureId, idempotencyKey: nonce.current, reviewFingerprint: review.reviewFingerprint, reason: reason.trim() }); original.current = command; setCanRetry(true); receive(await ask("reconcile", command, signal)); }); };
  return <section className="resource-form" data-testid="signed-archive"><h4>{t("title")}</h4><p>{t("guidance")}</p><p role="status">{a(busy ? "sending" : state)}</p>
    {state !== "forbidden" && state !== "offline" ? <>
      {receipt ? <p data-testid="signed-archive-state">{t(receipt.state)}</p> : null}
      {pending ? <div className="resource-form"><p>{t("pending")}</p><button className="secondary-button" disabled={disabled || busy} data-testid="signed-archive-recover" onClick={() => { void perform(async signal => receive(await ask("recover", { idempotencyKey: nonce.current }, signal))); }}>{t("recover")}</button>
        {canRetry ? <button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform(async signal => { if (original.current) receive(await ask("reconcile", original.current, signal)); }); }}>{a("retryExact")}</button> : null}
        {unrecorded ? <><p>{a("unrecorded")}</p><button className="secondary-button" disabled={disabled || busy} onClick={clear}>{t("newReview")}</button></> : null}
      </div> : <><button className="secondary-button" disabled={disabled || busy} onClick={inspect} data-testid="signed-archive-review">{t("check")}</button>
        {review?.canReconcile && receipt?.state === "PENDING" ? <><label className="field"><span>{a("reason")}</span><textarea value={reason} minLength={8} maxLength={1000} disabled={disabled || busy} dir="auto" onChange={event => setReason(event.target.value)} data-testid="signed-archive-reason" /></label><button className="primary-button" disabled={disabled || busy || reason.trim().length < 8} onClick={reconcile} data-testid="signed-archive-reconcile">{t("reconcile")}</button></> : null}
      </>}
      {receipt?.state === "COMPLETE" ? <div className="form-actions"><button className="secondary-button" disabled={disabled || busy} onClick={() => { if (receipt.signedDocumentId) onOpen(receipt.signedDocumentId); }} data-testid="signed-archive-open-original">{t("openOriginal")}</button><button className="secondary-button" disabled={disabled || busy} onClick={() => { if (receipt.certificateDocumentId) onOpen(receipt.certificateDocumentId); }} data-testid="signed-archive-open-certificate">{t("openCertificate")}</button></div> : null}
    </> : null}
  </section>;
}
