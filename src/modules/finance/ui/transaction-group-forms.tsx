"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createTransactionGroupAction, changeTransactionGroupMembershipAction } from "../application/transaction-group-actions";
import { transactionGroupSchema, transactionGroupEntrySchema } from "../domain/transaction-group";

type ErrorCode = "forbidden" | "conflict" | "validation" | "error";
function useRequestState() {
  const key = useRef<string | null>(null), [ready, setReady] = useState(false), [pending, start] = useTransition();
  const [error, setError] = useState<ErrorCode | null>(null), [saved, setSaved] = useState(false);
  useEffect(() => { queueMicrotask(() => { key.current = crypto.randomUUID(); setReady(true); }); }, []);
  return { key, ready, pending, start, error, setError, saved, setSaved };
}
export function TransactionGroupForm({ locale }: { locale: string }) {
  const t = useTranslations("TransactionGroups"), router = useRouter(), state = useRequestState();
  return <form className="resource-form" data-testid="transaction-group-form" aria-busy={state.pending} onSubmit={event => {
    event.preventDefault(); if (!state.key.current || state.pending) return;
    const form = new FormData(event.currentTarget);
    const input = transactionGroupSchema.safeParse({ name: form.get("name"), reason: form.get("reason"), idempotencyKey: state.key.current });
    state.setError(null); if (!input.success) { state.setError("validation"); return; }
    state.start(async () => {
      try {
        const result = await createTransactionGroupAction(input.data);
        if (!result.ok) { state.setError(result.code); return; }
        router.push(`/${locale}/app/finance/groups/${result.data.id}`);
      } catch { state.setError("error"); }
    });
  }}>
    <h2>{t("create")}</h2>
    {state.error ? <p role="alert" data-testid="transaction-group-error">{t(state.error)}</p> : null}
    <fieldset className="resource-form" disabled={!state.ready || state.pending}><legend>{t("groupDetails")}</legend>
      <label className="field"><span>{t("name")}</span><input name="name" maxLength={120} required data-testid="transaction-group-name" /></label>
      <label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={6} maxLength={500} required data-testid="transaction-group-reason" /></label>
      <div className="form-actions"><button className="primary-button" type="submit" data-testid="transaction-group-create">{t(state.pending ? "saving" : "create")}</button></div>
    </fieldset>
  </form>;
}

type Candidate = { id: string; reference: string; previousEntryId: string | null };
type MembershipProps = { groupId: string } & ({ kind: "attach"; candidates: Candidate[] } | { kind: "detach"; transaction: Candidate });
export function TransactionGroupMembershipForm(props: MembershipProps) {
  const t = useTranslations("TransactionGroups"), router = useRouter(), state = useRequestState();
  const attaching = props.kind === "attach";
  return <form className="resource-form" data-testid={`transaction-group-${props.kind}-form`} aria-busy={state.pending} onSubmit={event => {
    event.preventDefault(); if (!state.key.current || state.pending) return;
    const element = event.currentTarget, form = new FormData(element);
    const selected = props.kind === "attach" ? props.candidates.find(row => row.id === form.get("transactionId")) : props.transaction;
    state.setError(null); state.setSaved(false); if (!selected) { state.setError("validation"); return; }
    const input = transactionGroupEntrySchema.safeParse({ groupId: props.groupId, transactionId: selected.id, previousEntryId: selected.previousEntryId,
      action: attaching ? "ATTACH" : "DETACH", reason: form.get("reason"), idempotencyKey: state.key.current });
    if (!input.success) { state.setError("validation"); return; }
    state.start(async () => {
      try {
        const result = await changeTransactionGroupMembershipAction(input.data);
        if (!result.ok) { state.setError(result.code); return; }
        state.key.current = crypto.randomUUID(); element.reset(); state.setSaved(true); router.refresh();
      } catch { state.setError("error"); }
    });
  }}>
    {state.error ? <p role="alert" data-testid="transaction-group-error">{t(state.error)} <button className="secondary-button" type="button" onClick={() => router.refresh()}>{t("refresh")}</button></p> : null}
    {state.saved ? <p role="status" data-testid="transaction-group-saved">{t("saved")}</p> : null}
    <fieldset className="resource-form" disabled={!state.ready || state.pending || (props.kind === "attach" && !props.candidates.length)}>
      <legend>{t(attaching ? "attach" : "detach")}</legend>
      {props.kind === "attach" ? <label className="field"><span>{t("transaction")}</span><select name="transactionId" defaultValue="" required data-testid="transaction-group-candidate">
        <option value="">{t("selectTransaction")}</option>{props.candidates.map(row => <option key={row.id} value={row.id}>{row.reference}</option>)}
      </select></label> : null}
      <label className="field"><span>{t("reason")}</span><textarea name="reason" minLength={6} maxLength={500} required data-testid="transaction-group-membership-reason" /></label>
      <div className="form-actions"><button className={attaching ? "primary-button" : "secondary-button"} type="submit" data-testid={`transaction-group-${props.kind}`}>{t(state.pending ? "saving" : props.kind)}</button></div>
    </fieldset>
  </form>;
}
