"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { nativeSignatureChoicesSchema, nativeSignatureCommandSchema, nativeSignatureDraftSchema, nativeSignatureReceiptSchema, nativeSignatureRecoverySchema, nativeSignatureReviewSchema, signatureRecipientReferenceSchema } from "../domain/document-signature-command";
import { clearDocumentNonce, documentRequest, DocumentBrowserError, readDocumentNonce, writeDocumentNonce, type DocumentBrowserState } from "./document-browser";
import { DocumentSignaturePreparationPanel } from "./document-signature-preparation-panel";

type Choices = z.infer<typeof nativeSignatureChoicesSchema>;
type Party = Choices["items"][number];
type Review = { draft: z.infer<typeof nativeSignatureDraftSchema>; value: z.infer<typeof nativeSignatureReviewSchema>; reason: string };
const partyKey = (party: Party) => party.reference.kind + ":" + party.reference.id;

export function DocumentSignaturePanel({ scope, version, disabled, onClose }: { scope: string; version: { id: string; title: string; number: number }; disabled: boolean; onClose: () => void }) {
  const t = useTranslations("DocumentSignatures"), a = useTranslations("DocumentArchive"), key = "alvillas:document-signature:" + scope;
  const [kind, setKind] = useState<Party["reference"]["kind"]>("OWNER"), [query, setQuery] = useState(""), [choices, setChoices] = useState<Choices | null>(null),
    [selected, setSelected] = useState<Party[]>([]), [reason, setReason] = useState(""), [review, setReview] = useState<Review | null>(null),
    [state, setState] = useState<DocumentBrowserState>("ready"), [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [unrecorded, setUnrecorded] = useState(false),
    [canRetry, setCanRetry] = useState(false), [receipt, setReceipt] = useState<z.infer<typeof nativeSignatureReceiptSchema> | null>(null);
  const live = useRef(false), running = useRef(false), requests = useRef(new Set<AbortController>()), nonce = useRef<string | null>(null), original = useRef<z.infer<typeof nativeSignatureCommandSchema> | null>(null);
  useEffect(() => {
    live.current = true; nonce.current = readDocumentNonce(key); queueMicrotask(() => { if (live.current) setPending(Boolean(nonce.current)); });
    const wipe = () => { for (const controller of requests.current) controller.abort(); requests.current.clear(); running.current = false; original.current = null;
      setChoices(null); setSelected([]); setQuery(""); setReason(""); setReview(null); setReceipt(null); setCanRetry(false); setBusy(false); setUnrecorded(false); setPending(Boolean(nonce.current)); setState(navigator.onLine ? "ready" : "offline"); },
      hidden = () => { if (document.visibilityState === "hidden") wipe(); };
    window.addEventListener("offline", wipe); window.addEventListener("pagehide", wipe); window.addEventListener("focus", wipe); document.addEventListener("visibilitychange", hidden);
    const active = requests.current;
    return () => { live.current = false; for (const controller of active) controller.abort(); active.clear(); original.current = null;
      window.removeEventListener("offline", wipe); window.removeEventListener("pagehide", wipe); window.removeEventListener("focus", wipe); document.removeEventListener("visibilitychange", hidden); };
  }, [key]);
  const ask = async (path: string, input: unknown, signal: AbortSignal): Promise<unknown> => {
    const response = await documentRequest(scope, "signatures/" + path, input, signal), result: unknown = await response.json();
    if (!live.current || signal.aborted) throw new DOMException("Aborted", "AbortError"); return result;
  };
  const perform = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (disabled || running.current) return; if (!navigator.onLine) { setState("offline"); return; }
    const controller = new AbortController(); requests.current.add(controller); running.current = true; setBusy(true); setState("loading");
    try { await work(controller.signal); }
    catch (error) { if (live.current && !controller.signal.aborted) {
      const code = error instanceof DocumentBrowserError ? error.state : error instanceof z.ZodError ? "validation" : nonce.current ? "uncertain" : "unavailable";
      setState(code); if (code === "forbidden") { original.current = null; setCanRetry(false); setChoices(null); setSelected([]); setQuery(""); setReason(""); setReview(null); setReceipt(null); }
    } }
    finally { requests.current.delete(controller); if (live.current && !controller.signal.aborted) { running.current = false; setBusy(false); } }
  };
  const receive = (value: z.infer<typeof nativeSignatureReceiptSchema>) => {
    if (value.idempotencyKey !== nonce.current || (original.current && (value.instanceId !== original.current.instanceId || value.documentVersionId !== original.current.documentVersionId))) throw new DocumentBrowserError("unavailable");
    clearDocumentNonce(key, value.idempotencyKey); nonce.current = null; original.current = null; setPending(false); setCanRetry(false); setUnrecorded(false); setReview(null); setChoices(null); setSelected([]); setReason(""); setQuery(""); setReceipt(value); setState(value.state === "DRAFT" ? "saved" : "conflict");
  };
  const search = (cursor?: string) => { void perform(async signal => {
    const data = nativeSignatureChoicesSchema.parse(await ask("choices", { documentVersionId: version.id, kind, query, ...cursor ? { cursor } : {} }, signal));
    if (data.documentVersionId !== version.id) throw new DocumentBrowserError("unavailable"); setChoices(data); setState("ready");
  }); };
  const reviewDraft = (event: FormEvent) => { event.preventDefault(); if (!choices || !selected.length) return; void perform(async signal => {
    const draft = nativeSignatureDraftSchema.parse({ instanceId: choices.instanceId, documentVersionId: version.id, recipients: selected.map(party => party.reference) });
    if (reason.trim().length < 8) throw new DocumentBrowserError("validation"); const value = nativeSignatureReviewSchema.parse(await ask("review", draft, signal));
    if (value.document.instanceId !== draft.instanceId || value.document.versionId !== draft.documentVersionId) throw new DocumentBrowserError("unavailable");
    setReview({ draft, value, reason: reason.trim() }); setReceipt(null); setState("ready");
  }); };
  const save = () => { if (!review) return; void perform(async signal => {
    nonce.current ??= crypto.randomUUID(); writeDocumentNonce(key, nonce.current); setPending(true); setUnrecorded(false);
    const command = nativeSignatureCommandSchema.parse({ ...review.draft, idempotencyKey: nonce.current, reviewFingerprint: review.value.reviewFingerprint, reason: review.reason });
    original.current = command; setCanRetry(true); receive(nativeSignatureReceiptSchema.parse(await ask("admit", command, signal)));
  }); };
  const locked = disabled || busy || pending;
  if (state === "forbidden" || state === "offline") return <section className="resource-form" data-testid="signature-private-unavailable"><h2>{t("title")}</h2><p role="alert">{a(state)}</p><button className="secondary-button" onClick={onClose}>{t("close")}</button></section>;
  return <section className="resource-form" data-testid="document-signature"><h2>{t("title")}</h2><p>{t("guidance")}</p>{!pending && !receipt ? <p dir="auto">{a("version", { number: version.number })} · {version.title}</p> : null}
    <p role="status" data-testid="signature-status">{a(busy ? "sending" : state)}</p>
    {receipt ? <p data-testid="signature-receipt">{t(receipt.state === "DRAFT" ? "saved" : "changed")}</p> : null}
    {pending ? <div className="resource-form"><p>{t("pending")}</p><div className="form-actions"><button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform(async signal => {
      const value = nativeSignatureRecoverySchema.parse(await ask("recover", { idempotencyKey: nonce.current }, signal)); if (value.idempotencyKey !== nonce.current) throw new DocumentBrowserError("unavailable");
      if (value.recorded) receive(value); else { setUnrecorded(true); setState("ready"); }
    }); }} data-testid="signature-recover">{t("recover")}</button>
      {canRetry ? <button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform(async signal => { if (original.current) receive(nativeSignatureReceiptSchema.parse(await ask("admit", original.current, signal))); }); }}>{a("retryExact")}</button> : null}
      {unrecorded ? <><p>{a("unrecorded")}</p><button className="secondary-button" disabled={disabled || busy} onClick={() => { if (nonce.current) clearDocumentNonce(key, nonce.current); nonce.current = null; original.current = null; setPending(false); setCanRetry(false); setReview(null); setUnrecorded(false); }}>{t("newDraft")}</button></> : null}</div></div> : null}
    {!pending ? <form className="resource-form" onSubmit={reviewDraft} onChange={() => setReview(null)} data-testid="signature-form">
      <label className="field"><span>{t("recipientKind")}</span><select value={kind} disabled={locked} onChange={event => { setKind(signatureRecipientReferenceSchema.shape.kind.parse(event.target.value)); setChoices(null); }}>{(["OWNER", "GUEST", "SUPPLIER", "PERSON"] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label>
      <label className="field"><span>{t("search")}</span><input value={query} maxLength={120} disabled={locked} onChange={event => { setQuery(event.target.value); setChoices(null); }} dir="auto" data-testid="signature-query" /></label>
      <button type="button" className="secondary-button" disabled={locked} onClick={() => search()} data-testid="signature-find">{t("find")}</button>
      {choices ? <><ul className="resource-list">{choices.items.map(party => <li className="resource-form" key={partyKey(party)}><span dir="auto">{party.displayName}</span><span dir="auto">{party.email}</span><button type="button" className="secondary-button" disabled={locked || selected.some(value => partyKey(value) === partyKey(party)) || selected.length >= 100} onClick={() => { setSelected(previous => [...previous, party]); setReview(null); }} data-testid="signature-add-recipient">{t("add")}</button></li>)}</ul>{!choices.items.length ? <p>{t("empty")}</p> : null}{choices.next ? <button type="button" className="secondary-button" disabled={locked} onClick={() => search(choices.next ?? undefined)}>{t("more")}</button> : null}</> : null}
      {selected.length ? <fieldset className="resource-form"><legend>{t("selected")}</legend><ul className="resource-list">{selected.map(party => <li key={partyKey(party)}><span dir="auto">{party.displayName} · {party.email}</span><button type="button" className="quiet-button" disabled={locked} onClick={() => { setSelected(previous => previous.filter(value => partyKey(value) !== partyKey(party))); setReview(null); }}>{t("remove")}</button></li>)}</ul></fieldset> : null}
      <label className="field"><span>{a("reason")}</span><textarea value={reason} minLength={8} maxLength={1000} required disabled={locked} onChange={event => setReason(event.target.value)} dir="auto" data-testid="signature-reason" /></label>
      <button type="submit" className="secondary-button" disabled={locked || !choices || !selected.length} data-testid="signature-review">{t("review")}</button>
    </form> : null}
    {review && !pending ? <section className="resource-form" data-testid="signature-reviewed"><h3>{t("reviewed")}</h3><p dir="auto">{review.value.document.title}</p><ul className="resource-list">{review.value.recipients.map(party => <li key={partyKey(party)} dir="auto">{party.displayName} · {party.email}</li>)}</ul><button className="primary-button" disabled={locked} onClick={save} data-testid="signature-save">{t("save")}</button></section> : null}
    <DocumentSignaturePreparationPanel scope={scope} signatureId={receipt?.state === "DRAFT" ? receipt.id : null} disabled={disabled || busy} />
    <button className="quiet-button" disabled={busy} onClick={onClose}>{t("close")}</button>
  </section>;
}
