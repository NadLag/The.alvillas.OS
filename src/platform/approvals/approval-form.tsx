"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { approvalRequestAction, approvalDecisionAction } from "./approval-actions";
import { approvalRequestSchema, approvalDecisionSchema } from "./approval";
import type { getApproval } from "./approval-service";

export function ApprovalForm({ propertyId, approval }: { propertyId?: string; approval?: Awaited<ReturnType<typeof getApproval>> }) {
  const t = useTranslations("Approvals"); const locale = useLocale(); const router = useRouter();
  const [pending, startTransition] = useTransition(); const [offline, setOffline] = useState(false); const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  const key = useRef<string | null>(null);
  useEffect(() => {
    const network = () => setOffline(!navigator.onLine); queueMicrotask(() => { network(); setReady(true); });
    window.addEventListener("online", network); window.addEventListener("offline", network);
    return () => { window.removeEventListener("online", network); window.removeEventListener("offline", network); };
  }, []);
  return <section className="notification-settings" data-testid="approval-form" aria-busy={pending}>
    {offline ? <p role="status">{t("offline")}</p> : null}
    {error ? <p role="alert">{t("error")}</p> : null}
    {approval ? <><h2>{approval.title}</h2><p>{approval.details}</p><p data-testid="approval-state" role="status">{t(`states.${approval.state}`)}</p>
      {approval.decisionReason ? <p>{approval.decisionReason}</p> : null}</> : <p>{t("description")}</p>}
    {!approval || approval.canApprove || approval.canReject ? <form onSubmit={(event) => {
      event.preventDefault(); const form = new FormData(event.currentTarget); setError(false);
      key.current ??= crypto.randomUUID();
      const decision = event.nativeEvent.submitter?.getAttribute("value");
      const input = approval ? approvalDecisionSchema.safeParse({ id: approval.id, stageId: approval.stageId, decision, reason: form.get("reason") }) : approvalRequestSchema.safeParse({ propertyId, title: form.get("title"), details: form.get("details"), idempotencyKey: key.current });
      if (!input.success) { setError(true); return; }
      startTransition(async () => {
        try {
          if (approval) { const result = await approvalDecisionAction(input.data); if (!result.ok) setError(true); else router.refresh(); }
          else { const result = await approvalRequestAction(input.data); if (!result.ok) setError(true); else router.push(`/${locale}/app/approvals/${result.data.id}`); }
        } catch { setError(true); }
      });
    }}><fieldset className="notification-channel" disabled={pending || offline || !ready}><legend>{t(approval ? "decision" : "request")}</legend>
      {!approval ? <><label className="field"><span>{t("subject")}</span><input name="title" data-testid="approval-title" minLength={3} maxLength={160} required /></label>
        <label className="field"><span>{t("details")}</span><textarea name="details" data-testid="approval-details" minLength={6} maxLength={2000} required /></label></> :
        <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="approval-reason" minLength={6} maxLength={500} required /></label>}
      <div className="notification-actions">
        {!approval ? <button className="primary-button" type="submit" data-testid="approval-request">{t(pending ? "saving" : "request")}</button> : <>
          {approval.canApprove ? <button className="primary-button" type="submit" value="APPROVED" data-testid="approval-approve">{t(pending ? "saving" : "approve")}</button> : null}
          {approval.canReject ? <button className="secondary-button" type="submit" value="REJECTED" data-testid="approval-reject">{t("reject")}</button> : null}</>}
      </div>
    </fieldset></form> : null}
  </section>;
}
