"use client";
import { useEffect, useId, useState, useSyncExternalStore, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { closeAccountingPeriodSchema, reopenAccountingPeriodSchema } from "../domain/accounting-period";
import { closeAccountingPeriodAction, reopenAccountingPeriodAction } from "../application/accounting-period-actions";

type Code = "forbidden" | "conflict" | "validation" | "missingPolicy" | "earlyClose" | "invalidWindow" | "unbalanced" | "timezoneData" | "error";
type Common = { locale: string; requestKey: string; expectedVersion: number };
type Props = Common & ({ kind: "close"; month?: string } | { kind: "reopen"; periodId: string; maxSeconds: number });
const subscribeReady = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
export function AccountingPeriodExpiry({ deadline, serverNow }: { deadline: string; serverNow: string }) {
  const router = useRouter();
  useEffect(() => {
    const remaining = new Date(deadline).getTime() - new Date(serverNow).getTime();
    const timer = window.setTimeout(() => router.refresh(), Math.min(Math.max(0, remaining + 20), 2147000000));
    return () => window.clearTimeout(timer);
  }, [deadline, serverNow, router]);
  return null;
}
export function AccountingPeriodForm(props: Props) {
  const t = useTranslations("AccountingPeriods"), id = useId(), router = useRouter();
  const ready = useSyncExternalStore(subscribeReady, clientReady, serverReady);
  const [month, setMonth] = useState(props.kind === "close" ? props.month ?? "" : ""), [reason, setReason] = useState("");
  const [duration, setDuration] = useState(""), [error, setError] = useState<Code | null>(null), [pending, startTransition] = useTransition();
  const [requestKey] = useState(props.requestKey);
  const reopening = props.kind === "reopen";
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (pending) return;
    const common = { expectedVersion: props.expectedVersion, reason, idempotencyKey: requestKey };
    const input = props.kind === "reopen" ? { ...common, periodId: props.periodId, durationSeconds: Number(duration) } : { ...common, month };
    if (!(props.kind === "reopen" ? reopenAccountingPeriodSchema : closeAccountingPeriodSchema).safeParse(input).success) { setError("validation"); return; }
    setError(null);
    startTransition(async () => {
      try {
        const result = await (props.kind === "reopen" ? reopenAccountingPeriodAction(input) : closeAccountingPeriodAction(input));
        if (!result.ok) { setError(result.code); return; }
        router.push(`/${props.locale}/app/finance/periods/${result.data.id}`); router.refresh();
      } catch { setError("error"); }
    });
  }
  return <form className="resource-form accounting-period-form" onSubmit={submit} data-testid={reopening ? "accounting-period-reopen" : "accounting-period-close"} aria-busy={pending}>
    <fieldset disabled={!ready || pending}>
      <legend>{t(reopening ? "reopen" : "close")}</legend>
      {props.kind === "close" ? <label className="field" htmlFor={`${id}-month`}><span>{t("month")}</span>
        <input id={`${id}-month`} type="month" value={month} readOnly={Boolean(props.month)} onChange={event => setMonth(event.target.value)} required data-testid="accounting-period-month" /></label> :
        <label className="field" htmlFor={`${id}-duration`}><span>{t("duration")}</span>
          <input id={`${id}-duration`} type="number" inputMode="numeric" min={1} max={props.maxSeconds} step={1} value={duration} onChange={event => setDuration(event.target.value)} required data-testid="accounting-period-duration" />
          <small>{t("durationLimit", { seconds: props.maxSeconds })}</small></label>}
      <label className="field" htmlFor={`${id}-reason`}><span>{t("reason")}</span>
        <textarea id={`${id}-reason`} minLength={3} maxLength={1000} rows={3} value={reason} onChange={event => setReason(event.target.value)} required data-testid="accounting-period-reason" /></label>
      <div className="form-actions"><button className="primary-button" type="submit">{t(pending ? "saving" : reopening ? "reopen" : "close")}</button></div>
    </fieldset>
    {error ? <p className="form-error" role="alert">{t(`errors.${error}`)}</p> : null}
  </form>;
}
