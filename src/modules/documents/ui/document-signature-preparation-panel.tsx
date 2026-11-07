"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { signatureFieldSchema, signatureRecipientRoleSchema } from "@/platform/providers/signature-contract";
import { signaturePreparationCommandSchema, signaturePreparationDraftSchema, signaturePreparationTargetSchema, signaturePreparationReviewSchema, signaturePreparationReceiptSchema, signaturePreparationRecoverySchema } from "../domain/document-signature-preparation";
import { clearDocumentNonce, documentRequest, DocumentBrowserError, readDocumentNonce, writeDocumentNonce, type DocumentBrowserState } from "./document-browser";

type Target = z.infer<typeof signaturePreparationTargetSchema>;
type Command = z.infer<typeof signaturePreparationCommandSchema>;
type Field = { type: z.infer<typeof signatureFieldSchema>["type"]; page: string; positionX: string; positionY: string; width: string; height: string };
type Layout = { recipientId: string; role: z.infer<typeof signatureRecipientRoleSchema>; signingOrder: string; fields: Field[] };
type Review = { draft: z.infer<typeof signaturePreparationDraftSchema>; value: z.infer<typeof signaturePreparationReviewSchema>; reason: string };
const geometry = ["page", "positionX", "positionY", "width", "height"] as const;

export function DocumentSignaturePreparationPanel({ scope, signatureId, disabled, onPrepared, onForbidden }: { scope: string; signatureId: string | null; disabled: boolean; onPrepared: (id: string) => void; onForbidden: () => void }) {
  const t = useTranslations("SignaturePreparation"), a = useTranslations("DocumentArchive"), key = "alvillas:document-signature-preparation:" + scope;
  const [target, setTarget] = useState<Target | null>(null), [layouts, setLayouts] = useState<Layout[]>([]), [reason, setReason] = useState(""), [review, setReview] = useState<Review | null>(null),
    [receipt, setReceipt] = useState<z.infer<typeof signaturePreparationReceiptSchema> | null>(null), [pending, setPending] = useState(false), [unrecorded, setUnrecorded] = useState(false),
    [busy, setBusy] = useState(false), [canRetry, setCanRetry] = useState(false), [state, setState] = useState<DocumentBrowserState>("ready");
  const live = useRef(false), running = useRef(false), requests = useRef(new Set<AbortController>()), nonce = useRef<string | null>(null), original = useRef<Command | null>(null);
  useEffect(() => {
    live.current = true; nonce.current = readDocumentNonce(key);
    const wipe = () => { for (const controller of requests.current) controller.abort(); requests.current.clear(); running.current = false; original.current = null; setCanRetry(false); setTarget(null); setLayouts([]); setReason(""); setReview(null); setReceipt(null); setBusy(false); setUnrecorded(false); setPending(Boolean(nonce.current)); setState(navigator.onLine ? "ready" : "offline"); },
      hidden = () => { if (document.visibilityState === "hidden") wipe(); };
    queueMicrotask(() => { if (live.current) wipe(); });
    window.addEventListener("offline", wipe); window.addEventListener("pagehide", wipe); window.addEventListener("focus", wipe); document.addEventListener("visibilitychange", hidden); const active = requests.current;
    return () => { live.current = false; for (const controller of active) controller.abort(); active.clear(); original.current = null; window.removeEventListener("offline", wipe); window.removeEventListener("pagehide", wipe); window.removeEventListener("focus", wipe); document.removeEventListener("visibilitychange", hidden); };
  }, [key, signatureId]);
  const ask = async (path: string, input: unknown, signal: AbortSignal) => { const response = await documentRequest(scope, "signatures/preparation/" + path, input, signal), value: unknown = await response.json(); if (!live.current || signal.aborted) throw new DOMException("Aborted", "AbortError"); return value; };
  const perform = async (work: (signal: AbortSignal) => Promise<void>) => {
    if (disabled || running.current) return; if (!navigator.onLine) { setState("offline"); return; }
    const controller = new AbortController(); requests.current.add(controller); running.current = true; setBusy(true); setState("loading");
    try { await work(controller.signal); }
    catch (error) { if (live.current && !controller.signal.aborted) { const code = error instanceof DocumentBrowserError ? error.state : error instanceof z.ZodError ? "validation" : nonce.current ? "uncertain" : "unavailable"; setState(code);
      if (code === "forbidden") { setTarget(null); setLayouts([]); setReason(""); setReview(null); setReceipt(null); original.current = null; setCanRetry(false); onForbidden(); }
    } } finally { requests.current.delete(controller); if (live.current && !controller.signal.aborted) { running.current = false; setBusy(false); } }
  };
  const receive = (value: z.infer<typeof signaturePreparationReceiptSchema>) => {
    if (value.idempotencyKey !== nonce.current || original.current && value.signatureId !== original.current.signatureId) throw new DocumentBrowserError("unavailable");
    setReceipt(value); setTarget(null); setLayouts([]); setReason(""); setReview(null); setUnrecorded(false); original.current = null; setCanRetry(false);
    if (value.state === "PREPARED" || value.state === "SUPERSEDED") { clearDocumentNonce(key, value.idempotencyKey); nonce.current = null; setPending(false); } else setPending(true);
    setState(value.state === "PREPARED" ? "saved" : value.state === "SOURCE_CHANGED" ? "conflict" : value.state === "UNCERTAIN" ? "uncertain" : "ready");
    if (value.state === "PREPARED") onPrepared(value.id);
  };
  const load = () => { if (!signatureId) return; void perform(async signal => { const value = signaturePreparationTargetSchema.parse(await ask("target", { signatureId }, signal)); if (value.signatureId !== signatureId) throw new DocumentBrowserError("unavailable"); setTarget(value); setLayouts(value.recipients.map(recipient => ({ recipientId: recipient.id, role: "SIGNER", signingOrder: "", fields: [] }))); setReceipt(null); setReview(null); setState("ready"); }); };
  const update = (recipientId: string, change: (layout: Layout) => Layout) => { setLayouts(previous => previous.map(layout => layout.recipientId === recipientId ? change(layout) : layout)); setReview(null); };
  const reviewLayout = (event: FormEvent) => { event.preventDefault(); if (!target) return; void perform(async signal => {
    const draft = signaturePreparationDraftSchema.parse({ signatureId: target.signatureId, recipients: layouts.map(layout => ({ recipientId: layout.recipientId, role: layout.role, signingOrder: layout.signingOrder === "" ? undefined : Number(layout.signingOrder), fields: layout.fields.map(field => Object.fromEntries(Object.entries(field).map(([name, value]) => [name, name === "type" ? value : value === "" ? undefined : Number(value)]))) })) });
    if (reason.trim().length < 8) throw new DocumentBrowserError("validation"); const value = signaturePreparationReviewSchema.parse(await ask("review", draft, signal)); if (value.signatureId !== target.signatureId || value.document.versionId !== target.document.versionId) throw new DocumentBrowserError("unavailable"); setReview({ draft, value, reason: reason.trim() }); setState("ready");
  }); };
  const save = () => { if (!review) return; void perform(async signal => { nonce.current ??= crypto.randomUUID(); writeDocumentNonce(key, nonce.current); setPending(true);
    const command = signaturePreparationCommandSchema.parse({ ...review.draft, idempotencyKey: nonce.current, reviewFingerprint: review.value.reviewFingerprint, reason: review.reason }); original.current = command; setCanRetry(true); receive(signaturePreparationReceiptSchema.parse(await ask("admit", command, signal)));
  }); };
  if (!signatureId && !pending && !receipt) return null;
  const locked = disabled || busy || pending;
  return <section className="resource-form" data-testid="signature-preparation"><h3>{t("title")}</h3><p>{t("guidance")}</p><p role="status" data-testid="signature-preparation-status">{a(busy ? "sending" : state)}</p>
    {state !== "forbidden" && state !== "offline" ? <>
      {receipt ? <p data-testid="signature-preparation-receipt">{t(receipt.state)}</p> : null}
      {pending ? <div className="resource-form"><p>{t("pending")}</p><button className="secondary-button" disabled={disabled || busy} data-testid="signature-preparation-recover" onClick={() => { void perform(async signal => { const value = signaturePreparationRecoverySchema.parse(await ask("recover", { idempotencyKey: nonce.current }, signal)); if (value.idempotencyKey !== nonce.current) throw new DocumentBrowserError("unavailable"); if (value.recorded) receive(value); else { setUnrecorded(true); setState("ready"); } }); }}>{t("recover")}</button>
        {canRetry ? <button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform(async signal => { if (original.current) receive(signaturePreparationReceiptSchema.parse(await ask("admit", original.current, signal))); }); }}>{a("retryExact")}</button> : null}
        {unrecorded ? <><p>{a("unrecorded")}</p><button className="secondary-button" disabled={disabled || busy} onClick={() => { if (nonce.current) clearDocumentNonce(key, nonce.current); nonce.current = null; original.current = null; setCanRetry(false); setPending(false); setUnrecorded(false); setReview(null); }}>{t("newReview")}</button></> : null}
      </div> : null}
      {!pending && signatureId ? <button className="secondary-button" disabled={disabled || busy} onClick={load} data-testid="signature-preparation-load">{t("load")}</button> : null}
      {target && !pending ? <form className="resource-form" onSubmit={reviewLayout} data-testid="signature-preparation-form"><p dir="auto">{target.document.title}</p><p>{t("pages", { count: target.document.pageCount })}</p><p dir="auto">{target.signatureLevel}</p>
        <p>{t(target.signing.order)}</p><ul className="resource-list">{(["typed", "draw", "upload"] as const).map(method => <li key={method}>{t(method)}: {t(target.signing.methods[method] ? "enabled" : "disabled")}</li>)}</ul>
        <p>{t("expiration")}: {"disabled" in target.signing.delivery.expiration ? t("disabled") : t("period", { count: target.signing.delivery.expiration.amount, unit: t(target.signing.delivery.expiration.unit) })}</p>
        {(["sendAfter", "repeatEvery"] as const).map(name => { const period = target.signing.delivery.reminders[name]; return <p key={name}>{t(name)}: {"disabled" in period ? t("disabled") : t("period", { count: period.amount, unit: t(period.unit) })}</p>; })}
        {layouts.map(layout => { const party = target.recipients.find(recipient => recipient.id === layout.recipientId); return <fieldset className="resource-form" key={layout.recipientId}><legend dir="auto">{party?.displayName}</legend><p dir="auto">{party?.email}</p>
          <label className="field"><span>{t("role")}</span><select value={layout.role} disabled={locked} onChange={event => { const role = signatureRecipientRoleSchema.parse(event.target.value); update(layout.recipientId, value => ({ ...value, role })); }}>{signatureRecipientRoleSchema.options.map(role => <option key={role} value={role}>{t(role)}</option>)}</select></label>
          <label className="field"><span>{t("signingOrder")}</span><input type="number" min={target.signing.order === "SEQUENTIAL" && ["SIGNER", "APPROVER"].includes(layout.role) ? 1 : 0} step="1" value={layout.signingOrder} required disabled={locked} onChange={event => { const signingOrder = event.target.value; update(layout.recipientId, value => ({ ...value, signingOrder })); }} data-testid="signature-preparation-order" /></label>
          {layout.fields.map((field, index) => <fieldset className="resource-form" key={index}><legend>{t("field", { number: index + 1 })}</legend><label className="field"><span>{t("fieldType")}</span><select value={field.type} disabled={locked} onChange={event => { const type = signatureFieldSchema.shape.type.parse(event.target.value); update(layout.recipientId, value => ({ ...value, fields: value.fields.map((item, position) => position === index ? { ...item, type } : item) })); }}>{signatureFieldSchema.shape.type.options.map(type => <option key={type} value={type}>{t(type)}</option>)}</select></label>
            {geometry.map(name => <label className="field" key={name}><span>{t(name)}</span><input type="number" min={name === "page" ? 1 : 0} max={name === "page" ? target.document.pageCount : 100} step={name === "page" ? "1" : "any"} value={field[name]} required disabled={locked} onChange={event => { const next = event.target.value; update(layout.recipientId, value => ({ ...value, fields: value.fields.map((item, position) => position === index ? { ...item, [name]: next } : item) })); }} data-testid={"signature-preparation-" + name} /></label>)}
            <button type="button" className="quiet-button" disabled={locked} onClick={() => update(layout.recipientId, value => ({ ...value, fields: value.fields.filter((_, position) => position !== index) }))}>{t("removeField")}</button></fieldset>)}
          <button type="button" className="secondary-button" disabled={locked || layout.fields.length >= 200} data-testid="signature-preparation-add-field" onClick={() => update(layout.recipientId, value => ({ ...value, fields: [...value.fields, { type: "SIGNATURE", page: "", positionX: "", positionY: "", width: "", height: "" }] }))}>{t("addField")}</button>
        </fieldset>; })}
        <label className="field"><span>{a("reason")}</span><textarea value={reason} minLength={8} maxLength={1000} required disabled={locked} onChange={event => { setReason(event.target.value); setReview(null); }} dir="auto" data-testid="signature-preparation-reason" /></label>
        <button type="submit" className="secondary-button" disabled={locked} data-testid="signature-preparation-review">{t("review")}</button>
      </form> : null}
      {review && !pending ? <section className="resource-form" data-testid="signature-preparation-reviewed"><h4>{t("reviewed")}</h4><p dir="auto">{review.value.document.title}</p><ul className="resource-list">{review.value.recipients.map(party => <li key={party.id} dir="auto">{party.displayName} · {party.email}</li>)}</ul><p>{t("fieldCount", { count: review.draft.recipients.reduce((count, recipient) => count + recipient.fields.length, 0) })}</p><button className="primary-button" disabled={locked} onClick={save} data-testid="signature-preparation-save">{t("save")}</button></section> : null}
    </> : null}
  </section>;
}
