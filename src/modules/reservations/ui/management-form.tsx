"use client";
import { useActionState, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { z } from "zod";
import { useTranslations } from "next-intl";
import { feedInputSchema, reservationImportSchema, blockInputSchema, changeReservationSchema, reservationFormValues } from "../domain/reservation";
import { reservationManagementAction, type ManagementAction, type ManagementState } from "../application/reservation-management-actions";

const subscribe = (callback: () => void) => { window.addEventListener("online", callback); window.addEventListener("offline", callback); return () => { window.removeEventListener("online", callback); window.removeEventListener("offline", callback); }; };
export function ManagementForm({ locale, kind, children, label, testId, idempotencyKey }: { locale: string; kind: ManagementAction; children: ReactNode; label: string; testId: string; idempotencyKey: string }) {
  const t = useTranslations("ReservationManagement");
  const [state, action, pending] = useActionState(reservationManagementAction.bind(null, locale, kind), { status: "idle" } as ManagementState);
  const online = useSyncExternalStore(subscribe, () => navigator.onLine, () => true);
  const [invalid, setInvalid] = useState(false), form = useRef<HTMLFormElement>(null), draft = useRef<FormData | null>(null);
  useEffect(() => {
    if (state.status !== "error" || !draft.current || !form.current) return;
    for (const [key, value] of draft.current) {
      const element = form.current.elements.namedItem(key);
      if (typeof value === "string" && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && element.type !== "hidden") element.value = value;
    }
  }, [state]);
  return <form ref={form} action={action} className="reservation-management-form" data-testid={testId} onSubmit={event => {
    const data = new FormData(event.currentTarget), values = reservationFormValues(data);
    const schema = kind === "connect" ? feedInputSchema : kind === "import" ? reservationImportSchema : kind === "block" ? blockInputSchema : kind === "change" ? changeReservationSchema : z.object({});
    const valid = schema.safeParse(values).success; setInvalid(!valid); draft.current = data;
    if (!valid) event.preventDefault();
  }}>
    <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
    <fieldset disabled={pending || !online}>{children}
      <button className="secondary-button" type="submit">{pending ? t("saving") : label}</button>
    </fieldset>
    {!online ? <p role="status">{t("offline")}</p> : null}
    {invalid ? <p className="form-error" role="alert">{t("errors.validation")}</p> : null}
    {state.status === "error" ? <p className="form-error" role="alert">{t(`errors.${state.message ?? "generic"}`)}</p> : null}
    {state.status === "success" ? <p role="status">{state.counts ? t("importResult", state.counts) : t("saved")}</p> : null}
  </form>;
}
export function CsvField() {
  const t = useTranslations("ReservationManagement");
  const [csv, setCsv] = useState(""), [error, setError] = useState(false);
  return <><label className="field"><span>{t("csvFile")}</span><input type="file" accept=".csv,text/csv" onChange={event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (file.size > 2000000 || !/\.csv$/iu.test(file.name)) { setError(true); return; }
    void file.text().then(value => { setCsv(value); setError(false); }, () => setError(true));
  }} /></label><label className="field"><span>{t("csv")}</span><textarea name="csv" rows={6} required value={csv} onChange={event => setCsv(event.target.value)} maxLength={2000000} data-testid="reservation-import-csv" /></label><label className="field"><span>{t("dateFormat")}</span><select name="dateFormat"><option value="ISO">{t("dateFormats.ISO")}</option><option value="MDY">{t("dateFormats.MDY")}</option><option value="DMY">{t("dateFormats.DMY")}</option></select></label>{error ? <p role="alert">{t("errors.validation")}</p> : null}<p className="muted-copy">{t("csvHint")}</p></>;
}
