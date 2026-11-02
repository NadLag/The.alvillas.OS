"use client";

import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { teamMutationAction, type TeamActionState } from "../application/team-actions";
import { parseTeamForm, type TeamOperation } from "../domain/team";
import {TeamScopePicker} from "./team-scope-picker";

const initialState: TeamActionState = { status: "idle" };
function Field({
  name,
  type = "text",
  value,
  required = true,
  children
}: {
  name: string;
  type?: string;
  value?: string;
  required?: boolean;
  children?: ReactNode;
}) {
  const t = useTranslations("Team");
  const id = useId();
  return (
    <div className="team-field">
      <label htmlFor={id}>{t(`fields.${name}`)}</label>
      {children ? (
        <select id={id} name={name} defaultValue={value} required={required}>
          {children}
        </select>
      ) : (
        <input
          id={id}
          name={name}
          type={type}
          defaultValue={value}
          required={required}
          maxLength={type === "text" ? 500 : undefined}
          minLength={name === "reason" ? 6 : undefined}
          step={name === "amount" ? "0.01" : undefined}
          min={name === "amount" ? "0" : undefined}
        />
      )}
    </div>
  );
}
function Hidden({ name, value }: { name: string; value: string | number }) {
  return <input type="hidden" name={name} value={value} />;
}
function TeamForm({
  operation,
  children,
  submit = "save",
  primary = false,
  maxFileBytes
}: {
  operation: TeamOperation;
  children: ReactNode;
  submit?: string;
  primary?: boolean;
  maxFileBytes?: number;
}) {
  const locale = useLocale();
  const t = useTranslations("Team");
  const [state, setState] = useState(initialState);
  const [pending, startTransition] = useTransition();
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        try {
          const file = data.get("file");
          if (maxFileBytes && file instanceof File && file.size > maxFileBytes) {
            setState({ status: "invalid" });
            return;
          }
          parseTeamForm(operation, data);
        } catch {
          setState({ status: "invalid" });
          return;
        }
        startTransition(async () => {
          try {
            setState(await teamMutationAction(locale, operation, state, data));
          } catch {
            setState({ status: "unavailable" });
          }
        });
      }}
      className="team-form"
      data-testid={`team-${operation}-form`}
    >
      <fieldset disabled={pending || offline}>
        {children}
        <button className={primary ? "primary-button" : "secondary-button"} type="submit">
          {t(pending ? "saving" : submit)}
        </button>
      </fieldset>
      {offline ? <p role="status">{t("offline")}</p> : null}
      <p role="status" aria-live="polite">
        {state.status === "idle" ? "" : t(`result.${state.status}`)}
      </p>
      {state.status === "saved" && operation === "profile" && state.id ? (
        <Link href={`/${locale}/app/team/${state.id}`}>{t("openProfile")}</Link>
      ) : null}
    </form>
  );
}
export function TeamProfileForm({
  profile
}: {
  profile?: {
    id?: string;
    displayName?: string;
    email?: string | null;
    phone?: string | null;
    preferredLocale?: string;
  };
}) {
  const t = useTranslations("Team");
  return (
    <TeamForm operation="profile" primary={!profile} submit={profile ? "save" : "create"}>
      {profile?.id ? <Hidden name="personId" value={profile.id} /> : null}
      <Field name="displayName" value={profile?.displayName} />
      <Field name="email" type="email" value={profile?.email ?? ""} required={false} />
      <Field name="phone" type="tel" value={profile?.phone ?? ""} required={false} />
      <Field name="preferredLocale" value={profile?.preferredLocale ?? "en"}>
        {["en", "fr", "ar"].map((l) => (
          <option key={l} value={l}>
            {t(`locale.${l}`)}
          </option>
        ))}
      </Field>
    </TeamForm>
  );
}
export function TeamAssignmentForm({
  personId,
  roles,
  today,
  accounts
}: {
  personId: string;
  roles: { id: string; name: string }[];
  today: string;
  accounts: { id: string }[];
}) {
  const t = useTranslations("Team");
  const [scope, setScope] = useState("organization");
  const id = useId();
  return (
    <TeamForm operation="assignment">
      <Hidden name="personId" value={personId} />
      <Field name="roleId">
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </Field>
      <Field name="userAccountId" required={false}>
        {accounts.map((a, i) => (
          <option key={a.id} value={a.id}>
            {t("accountNumber", { number: i + 1 })}
          </option>
        ))}
        <option value="">{t("noAccount")}</option>
      </Field>
      <div className="team-field">
        <label htmlFor={id}>{t("fields.scopeType")}</label>
        <select id={id} name="scopeType" value={scope} onChange={(e) => setScope(e.target.value)}>
          {["organization", "property", "region", "city", "job"].map((s) => (
            <option key={s} value={s}>
              {t(`scope.${s}`)}
            </option>
          ))}
        </select>
      </div>
      {scope === "organization" ? (
        <Hidden name="scopeId" value="" />
      ) : scope === "job" ? (
        <Field name="scopeId" />
      ) : (
        <TeamScopePicker key={scope} type={scope as "property"|"region"|"city"}/>
      )}
      <Field name="validFrom" type="date" value={today} />
      <Field name="validTo" type="date" required={false} />
      <label className="team-check">
        <input type="checkbox" name="assignedToMe" />
        {t("assignedToMe")}
      </label>
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamCompensationForm({
  assignmentId,
  version,
  today,
  currency
}: {
  assignmentId: string;
  version: number;
  today: string;
  currency: string;
}) {
  const t = useTranslations("Team");
  return (
    <TeamForm operation="compensation">
      <Hidden name="assignmentId" value={assignmentId} />
      <Hidden name="expectedVersion" value={version} />
      <Field name="mode">
        {["PER_JOB", "PER_MONTH", "PER_HOUR", "PERCENTAGE"].map((m) => (
          <option key={m} value={m}>
            {t(`mode.${m}`)}
          </option>
        ))}
      </Field>
      <Field name="amount" type="number" />
      <Field name="currency" value={currency} />
      <Field name="effectiveFrom" type="date" value={today} />
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamAvailabilityForm({ personId }: { personId: string }) {
  const t = useTranslations("Team");
  return (
    <TeamForm operation="availability">
      <Hidden name="personId" value={personId} />
      <Field name="kind">
        {["AVAILABLE", "UNAVAILABLE", "LEAVE"].map((k) => (
          <option key={k} value={k}>
            {t(`kind.${k}`)}
          </option>
        ))}
      </Field>
      <Field name="startsOn" type="date" />
      <Field name="endsOn" type="date" />
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamDecisionForm({
  id,
  status,
  canApprove
}: {
  id: string;
  status: string;
  canApprove: boolean;
}) {
  const t = useTranslations("Team");
  return (
    <TeamForm operation="decision">
      <Hidden name="id" value={id} />
      <Field name="decision">
        {(canApprove && status === "REQUESTED"
          ? ["APPROVED", "REJECTED", "CANCELLED"]
          : ["CANCELLED"]
        ).map((s) => (
          <option key={s} value={s}>
            {t(`status.${s}`)}
          </option>
        ))}
      </Field>
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamRetireForm({ id }: { id: string }) {
  return (
    <TeamForm operation="retire" submit="endAssignment">
      <Hidden name="id" value={id} />
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamWalletForm({
  personId,
  accounts,
  canCreate,
  accountName
}: {
  personId: string;
  accounts: { id: string; name: string; code: string }[];
  canCreate: boolean;
  accountName: string;
}) {
  const t = useTranslations("Team");
  return (
    <TeamForm operation="wallet">
      <Hidden name="personId" value={personId} />
      <Field name="ledgerAccountId" required={!canCreate}>
        {canCreate ? <option value="">{t("createWallet")}</option> : null}
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </Field>
      {canCreate ? <Field name="accountName" value={accountName} /> : null}
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamOffboardForm({ personId }: { personId: string }) {
  return (
    <TeamForm operation="offboard" submit="offboard">
      <Hidden name="personId" value={personId} />
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamDocumentForm({ personId, maxBytes }: { personId: string; maxBytes: number }) {
  const t = useTranslations("Team");
  const id = useId();
  return (
    <TeamForm operation="document" submit="upload" maxFileBytes={maxBytes}>
      <Hidden name="personId" value={personId} />
      <Field name="title" />
      <Field name="kind">
        {["CONTRACT", "IDENTITY", "OTHER"].map((k) => (
          <option key={k} value={k}>
            {t(`kind.${k}`)}
          </option>
        ))}
      </Field>
      <Field name="expiresOn" type="date" required={false} />
      <p>{t("documentLimit", { megabytes: maxBytes / 1000000 })}</p>
      <label className="team-field" htmlFor={id}>
        <span>{t("fields.file")}</span>
        <input id={id} type="file" name="file" accept="application/pdf,image/jpeg,image/png" required />
      </label>
      <Field name="reason" />
    </TeamForm>
  );
}
export function TeamArchiveDocumentForm({ id }: { id: string }) {
  return (
    <TeamForm operation="archive_document" submit="archive">
      <Hidden name="id" value={id} />
      <Field name="reason" />
    </TeamForm>
  );
}
