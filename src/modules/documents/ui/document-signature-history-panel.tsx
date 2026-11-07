"use client";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { z } from "zod";
import { nativeSignatureHistorySchema, nativeSignatureListSchema } from "../domain/document-signature-history";
import { documentRequest, DocumentBrowserError, type DocumentBrowserState } from "./document-browser";
import { DocumentSignedArchivePanel } from "./document-signed-archive-panel";

type History = z.infer<typeof nativeSignatureHistorySchema>;
export function DocumentSignatureHistoryPanel({ scope, versionId, disabled, onOpen, onForbidden, onOpenArchive }: { scope: string; versionId: string; disabled: boolean; onOpen: (value: History) => void; onForbidden: () => void; onOpenArchive: (documentId: string) => void }) {
  const t = useTranslations("SignatureHistory"), a = useTranslations("DocumentArchive"), format = useFormatter(), [list, setList] = useState<z.infer<typeof nativeSignatureListSchema> | null>(null), [history, setHistory] = useState<History | null>(null), [state, setState] = useState<DocumentBrowserState>("ready"), [busy, setBusy] = useState(false);
  const live = useRef(false), running = useRef(false), requests = useRef(new Set<AbortController>());
  useEffect(() => { live.current = true; const wipe = () => { for (const request of requests.current) request.abort(); requests.current.clear(); running.current = false; setList(null); setHistory(null); setBusy(false); setState(navigator.onLine ? "ready" : "offline"); }, hidden = () => { if (document.visibilityState === "hidden") wipe(); };
    window.addEventListener("focus", wipe); window.addEventListener("offline", wipe); window.addEventListener("pagehide", wipe); document.addEventListener("visibilitychange", hidden); const active = requests.current;
    return () => { live.current = false; for (const request of active) request.abort(); active.clear(); window.removeEventListener("focus", wipe); window.removeEventListener("offline", wipe); window.removeEventListener("pagehide", wipe); document.removeEventListener("visibilitychange", hidden); };
  }, [scope, versionId]);
  const perform = async (path: "list" | "history", input: unknown) => {
    if (disabled || running.current) return; if (!navigator.onLine) { setState("offline"); return; } const controller = new AbortController(); requests.current.add(controller); running.current = true; setBusy(true); setState("loading");
    try { const response = await documentRequest(scope, "signatures/" + path, input, controller.signal), raw: unknown = await response.json(); if (!live.current || controller.signal.aborted) return;
      if (path === "list") { const value = nativeSignatureListSchema.parse(raw); if (value.documentVersionId !== versionId) throw new DocumentBrowserError("unavailable"); setList(value); setHistory(null); }
      else { const value = nativeSignatureHistorySchema.parse(raw); if (value.signature.documentVersionId !== versionId || value.signature.id !== (input as { signatureId: string }).signatureId) throw new DocumentBrowserError("unavailable"); setHistory(value); }
      setState("ready");
    } catch (error) { if (live.current && !controller.signal.aborted) { const code = error instanceof DocumentBrowserError ? error.state : error instanceof z.ZodError ? "validation" : "unavailable"; setState(code); if (code === "forbidden") { setList(null); setHistory(null); onForbidden(); } } }
    finally { requests.current.delete(controller); if (live.current && !controller.signal.aborted) { running.current = false; setBusy(false); } }
  };
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: "medium", timeStyle: "short" });
  return <section className="resource-form" data-testid="signature-history-panel"><h3>{t("title")}</h3><p>{t("guidance")}</p><p role="status">{a(busy ? "sending" : state)}</p>
    <button className="secondary-button" disabled={disabled || busy || state === "offline" || state === "forbidden"} onClick={() => { void perform("list", { documentVersionId: versionId }); }} data-testid="signature-history-find">{t("find")}</button>
    {state !== "offline" && state !== "forbidden" ? <>
      {list ? <><ul className="resource-list">{list.items.map(item => <li className="resource-form" key={item.id} data-testid="signature-history-item" data-signature-id={item.id}><span>{t(item.state)} · {date(item.requestedAt)}</span><button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform("history", { signatureId: item.id }); }} data-testid="signature-history-read">{t("read")}</button></li>)}</ul>{!list.items.length ? <p>{t("empty")}</p> : null}{list.next ? <button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform("list", { documentVersionId: versionId, cursor: list.next }); }}>{t("more")}</button> : null}</> : null}
      {history ? <section className="resource-form" data-testid="signature-history-details"><h4>{t("original")}</h4><p dir="auto">{history.document.title}</p><p>{t(history.signature.state)}</p><ul className="resource-list">{history.recipients.map(recipient => <li className="resource-form" key={recipient.id}><span dir="auto">{recipient.displayName}</span><span dir="auto">{recipient.email}</span></li>)}</ul>
        <ol className="resource-list">{history.events.map(event => <li key={event.id} data-testid="signature-history-event">{t(event.state)} · {date(event.occurredAt)}</li>)}</ol>{history.next ? <button className="secondary-button" disabled={disabled || busy} onClick={() => { void perform("history", { signatureId: history.signature.id, cursor: history.next }); }}>{t("moreEvents")}</button> : null}
        <button className="secondary-button" disabled={disabled || busy} onClick={() => onOpen(history)} data-testid="signature-history-open">{t("open")}</button>
        <DocumentSignedArchivePanel key={scope + ":" + history.signature.id} scope={scope} signatureId={history.signature.id} disabled={disabled || busy} onForbidden={onForbidden} onOpen={onOpenArchive} />
      </section> : null}
    </> : null}
  </section>;
}
