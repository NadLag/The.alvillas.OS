"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createPaymentAccountAction } from "../application/payment-account-actions";
import { paymentAccountKinds, paymentAccountSchema } from "../domain/payment-account";

export function PaymentAccountForm() {
  const t = useTranslations("FinancialAccounts"), router = useRouter(), key = useRef<string | null>(null);
  const [ready, setReady] = useState(false), [pending, startTransition] = useTransition();
  const [error, setError] = useState<"forbidden" | "conflict" | "validation" | "error" | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { queueMicrotask(() => { key.current = crypto.randomUUID(); setReady(true); }); }, []);
  return <form className="resource-form" data-testid="payment-account-form" aria-busy={pending} onSubmit={event => {
    event.preventDefault();
    if (!key.current || pending) return;
    const element = event.currentTarget, form = new FormData(element);
    setError(null); setSaved(false);
    const input = paymentAccountSchema.safeParse({ name: form.get("name"), kind: form.get("kind"), reason: form.get("reason"), idempotencyKey: key.current });
    if (!input.success) { setError("validation"); return; }
    startTransition(async () => {
      try {
        const result = await createPaymentAccountAction(input.data);
        if (!result.ok) { setError(result.code); return; }
        key.current = crypto.randomUUID(); element.reset(); setSaved(true); router.refresh();
      } catch { setError("error"); }
    });
  }}>
    {error ? <p role="alert" data-testid="payment-account-error">{t(error)}</p> : null}
    {saved ? <p role="status" data-testid="payment-account-saved">{t("saved")}</p> : null}
    <fieldset className="resource-form" disabled={!ready || pending}><legend>{t("create")}</legend>
      <div className="form-grid two">
        <label className="field"><span>{t("name")}</span><input name="name" data-testid="payment-account-name" maxLength={120} required /></label>
        <label className="field"><span>{t("kind")}</span><select name="kind" data-testid="payment-account-kind" defaultValue="" required>
          <option value="">{t("selectKind")}</option>{paymentAccountKinds.map(kind => <option value={kind} key={kind}>{t(`kinds.${kind}`)}</option>)}
        </select></label>
      </div>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" data-testid="payment-account-reason" minLength={6} maxLength={500} required /></label>
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="payment-account-create">{t(pending ? "saving" : "create")}</button></div>
    </fieldset>
  </form>;
}
