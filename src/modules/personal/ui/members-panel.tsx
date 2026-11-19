import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState, StatusBadge } from "@/design-system/shells";
import type { AppLocale } from "@/i18n/routing";
import { householdGrants, type HouseholdArea } from "../domain/household-access";
import { personalWorkspace } from "../application/personal-session";
import { PersonalForm } from "./personal-form";

export async function MembersPanel({ locale, householdId, after }: { locale: AppLocale; householdId: string; after?: string }) {
  const [t, members] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }),
    personalWorkspace(locale, householdId, (scope) => scope.members(after))
  ]);
  const target = { locale, householdId, command: "member" as const };

  function fields(member?: (typeof members.items)[number]) {
    return <>
      <label>{t("accountId")}<input name="accountId" defaultValue={member?.accountId} readOnly={Boolean(member)} required /></label>
      <label>{t("name")}<input name="displayName" defaultValue={member?.displayName} required maxLength={120} /></label>
      <label><input name="isChild" type="checkbox" defaultChecked={member?.isChild} /> {t("child")}</label>
      <fieldset>
        <legend>{t("grants")}</legend>
        <div className="form-grid two">
          {householdGrants.map((grant) => {
            const area = grant.slice(0, grant.indexOf(":")) as HouseholdArea;
            return <label key={grant}><input name="grant" type="checkbox" value={grant} defaultChecked={member?.grants.includes(grant)} /> {
              t(grant.endsWith(":view") ? "grantView" : "grantEdit", { area: t(`sections.${area}`) })
            }</label>;
          })}
        </div>
      </fieldset>
    </>;
  }

  return <section className="detail-panel">
    <h2>{t("sections.members")}</h2>
    <details><summary>{t("addMember")}</summary><PersonalForm target={target}>{fields()}</PersonalForm></details>
    {members.items.length ? <ul className="form-grid">
      {members.items.map((member) => <li key={member.accountId}>
        <div className="form-actions">
          <strong dir="auto">{member.displayName}</strong>
          {member.isSteward ? <StatusBadge>{t("steward")}</StatusBadge> : null}
          {member.revokedAt ? <StatusBadge>{t("revoked")}</StatusBadge> : null}
        </div>
        {!member.isSteward ? <details>
          <summary>{t("editMember")}</summary>
          <PersonalForm target={target}>{fields(member)}</PersonalForm>
          {!member.revokedAt ? <PersonalForm target={{ locale, householdId, command: "revoke" }} submitLabel={t("revoke")}>
            <input name="accountId" type="hidden" value={member.accountId} />
          </PersonalForm> : null}
        </details> : null}
      </li>)}
    </ul> : <EmptyState>{t("empty")}</EmptyState>}
    {members.next ? <Link className="secondary-button" prefetch={false} href={`?after=${members.next}`}>{t("next")}</Link> : null}
  </section>;
}
