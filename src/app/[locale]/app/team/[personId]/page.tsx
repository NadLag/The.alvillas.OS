import Link from "next/link";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound, redirect } from "next/navigation";
import { AdminShell, EmptyState, ShellHeader, StatusBadge } from "@/design-system/shells";
import { auth } from "@/platform/auth/session";
import { safeLocale } from "@/i18n/routing";
import { formatDate, formatCurrencyAmount, formatNumber } from "@/i18n/format";
import {
  teamActorContextFromSession,
  teamMember,
  TeamNotFoundError
} from "@/modules/identity/application/team-service";
import { IdentityAuthorizationError } from "@/modules/identity/application/identity-access";
import {
  TeamAssignmentForm,
  TeamAvailabilityForm,
  TeamCompensationForm,
  TeamDecisionForm,
  TeamDocumentForm,
  TeamOffboardForm,
  TeamProfileForm,
  TeamRetireForm,
  TeamWalletForm,
  TeamArchiveDocumentForm
} from "@/modules/identity/ui/team-forms";
import { maskedValue } from "@/platform/authz/present";
import { z } from "zod";
import { localizedText } from "@/i18n/content";
import { dateOnly } from "@/modules/identity/domain/team";

export const dynamic = "force-dynamic";
export default async function TeamMemberPage({
  params,
  searchParams
}: {
  params: Promise<{ locale: string; personId: string }>;
  searchParams: Promise<{ from?: string; until?: string; walletPage?: string }>;
}) {
  const values = await params;
  const locale = safeLocale(values.locale);
  setRequestLocale(locale);
  if (!z.string().uuid().safeParse(values.personId).success) notFound();
  const session = await auth();
  if (session?.user?.securitySetupRequired) redirect(`/${locale}/app/security`);
  const ctx = await teamActorContextFromSession(session);
  if (!ctx) redirect(`/${locale}/login`);
  const t = await getTranslations("Team");
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Casablanca",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
  const query = await searchParams;
  const from =
    query.from && dateOnly.safeParse(query.from).success ? query.from : `${today.slice(0, 7)}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  let until =
    query.until && dateOnly.safeParse(query.until).success
      ? query.until
      : end.toISOString().slice(0, 10);
  const invalidDates = Boolean(
    (query.from && from !== query.from) ||
      (query.until && until !== query.until) ||
      until <= from ||
      new Date(until).getTime() - new Date(from).getTime() > 366 * 86400000
  );
  if (invalidDates) until = end.toISOString().slice(0, 10);
  let data;
  try {
    data = await teamMember(ctx, {
      personId: values.personId,
      from,
      until,
      walletPage:
        /^\d{1,5}$/u.test(query.walletPage ?? "") && Number(query.walletPage) > 0
          ? Number(query.walletPage)
          : 1
    });
  } catch (error) {
    if (
      error instanceof TeamNotFoundError ||
      error instanceof IdentityAuthorizationError ||
      error instanceof z.ZodError
    )
      notFound();
    throw error;
  }
  const personId = values.personId;
  const date = (value: string) => formatDate(locale, new Date(value));
  const scopeName = (type: string, id: string | null) =>
    [...data.properties, ...data.regions, ...data.cities].find((p) => p.id === id)?.name ??
    (id ? id : t(`scope.${type}`));
  return (
    <AdminShell className="resource-page" testId="team-member-page">
      <ShellHeader
        eyebrow={t("eyebrow")}
        title={data.profile.displayName ?? ""}
        subtitle={t(data.profile.archived ? "offboarded" : "active")}
        actions={
          <Link className="secondary-button" href={`/${locale}/app/team`}>
            {t("directory")}
          </Link>
        }
      />
      <section className="team-section">
        <h2>{t("profile")}</h2>
        {data.canInviteAccount ? <Link className="secondary-button" href={`/${locale}/app/identity?personId=${personId}`}>{t("inviteAccount")}</Link> : null}
        <dl className="team-profile">
          <div>
            <dt>{t("fields.email")}</dt>
            <dd>{data.profile.email ?? t("notProvided")}</dd>
          </div>
          <div>
            <dt>{t("fields.phone")}</dt>
            <dd>{data.profile.phone ?? t("notProvided")}</dd>
          </div>
        </dl>
        {data.canEdit && !data.profile.archived ? (
          <details>
            <summary>{t("editProfile")}</summary>
            <TeamProfileForm profile={data.profile} />
          </details>
        ) : null}
      </section>
      <section className="team-section">
        <h2>{t("assignments")}</h2>
        {data.assignments.length ? (
          data.assignments.map((a) => (
            <article className="team-record" key={a.id} data-testid="team-assignment">
              <h3>{a.role}</h3>
              {a.archived ? <StatusBadge>{t("ended")}</StatusBadge> : null}
              <p>
                {t(`scope.${a.scopeType}`)} · {scopeName(a.scopeType, a.scopeId)}
              </p>
              <p>
                {date(a.validFrom)}
                {a.validTo ? ` – ${date(a.validTo)}` : ""}
              </p>
              {a.assignedToMe ? <p>{t("assignedToMe")}</p> : null}
              <h4>{t("compensation")}</h4>
              {a.compensation.length ? (
                <ol>
                  {a.compensation.map((c) => (
                    <li key={c.id}>
                      {t("version", { version: c.version })} · {t(`mode.${c.mode}`)} ·{" "}
                      <span className="money">
                        {c.mode === "PERCENTAGE"
                          ? t("percentage", { amount: formatNumber(locale, c.amount) })
                          : formatCurrencyAmount(locale, c.amount, c.currency)}
                      </span>{" "}
                      · {date(c.effectiveFrom)}
                      <p>{c.reason}</p>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{a.canViewCompensation ? t("noCompensation") : maskedValue}</p>
              )}
              {a.canCompensate && !data.profile.archived ? (
                <details>
                  <summary>{t("changeCompensation")}</summary>
                  <TeamCompensationForm
                    assignmentId={a.id}
                    version={a.compensation[0]?.version ?? 0}
                    today={today}
                    currency={data.baseCurrency}
                  />
                </details>
              ) : null}
              {a.canRetire && !data.profile.archived ? (
                <details>
                  <summary>{t("endAssignment")}</summary>
                  <TeamRetireForm id={a.id} />
                </details>
              ) : null}
            </article>
          ))
        ) : (
          <EmptyState>{t("noAssignments")}</EmptyState>
        )}
        {data.canAssign && !data.profile.archived ? (
          <details>
            <summary>{t("assign")}</summary>
            <TeamAssignmentForm
              personId={personId}
              roles={data.roles}
              properties={data.properties}
              regions={data.regions}
              cities={data.cities}
              accounts={data.accounts}
              today={today}
            />
          </details>
        ) : null}
      </section>
      <section className="team-section">
        <h2>{t("availability")}</h2>
        <p>{t("exclusiveEnd")}</p>
        {data.availability.length ? (
          data.availability.map((a) => (
            <article className="team-record" key={a.id}>
              <h3>{t(`kind.${a.kind}`)}</h3>
              <p>
                {date(a.startsOn)} – {date(a.endsOn)}
              </p>
              <StatusBadge>{t(`status.${a.status}`)}</StatusBadge>
              {a.reason ? <p>{a.reason}</p> : null}
              {!data.profile.archived &&
              ((data.canApprove && ["REQUESTED", "APPROVED"].includes(a.status)) ||
                (data.canRequest && a.status === "REQUESTED")) ? (
                <TeamDecisionForm id={a.id} status={a.status} canApprove={data.canApprove} />
              ) : null}
            </article>
          ))
        ) : (
          <EmptyState>{t("noAvailability")}</EmptyState>
        )}
        {data.canRequest && !data.profile.archived ? (
          <details>
            <summary>{t("requestAvailability")}</summary>
            <TeamAvailabilityForm personId={personId} />
          </details>
        ) : null}
      </section>
      <section className="team-section">
        <h2>{t("workload")}</h2>
        {invalidDates ? <p role="alert">{t("result.invalid")}</p> : null}
        <form className="team-search" method="get">
          <label htmlFor="team-from">{t("fields.startsOn")}</label>
          <input id="team-from" name="from" type="date" defaultValue={from} required />
          <label htmlFor="team-until">{t("fields.endsOn")}</label>
          <input id="team-until" name="until" type="date" defaultValue={until} required />
          <button className="secondary-button">{t("apply")}</button>
        </form>
        <h3>{t("performance")}</h3>
        {data.metrics ? (
          <dl className="team-metrics">
            {Object.entries(data.metrics).map(([key, value]) => (
              <div key={key}>
                <dt>{t(`metrics.${key}`)}</dt>
                <dd>{formatNumber(locale, String(value))}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p role="status">{t("narrowDates")}</p>
        )}
        {data.tasks.length ? (
          <ul className="team-workload">
            {data.tasks.map((task) => (
              <li key={task.id}>
                <strong>{localizedText(task.title as Record<string, string>, locale)}</strong>
                <span>{task.property}</span>
                <span>{date(task.dueDate)}</span>
                <StatusBadge>{t(`taskState.${task.state}`)}</StatusBadge>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>{t("noTasks")}</EmptyState>
        )}
      </section>
      <section className="team-section">
        <h2>{t("documents")}</h2>
        {data.canDocuments ? (
          <>
            <p>{t("documentPrivacy")}</p>
            <Link href={`/${locale}/app/notifications`}>{t("reminderSettings")}</Link>
            {data.documents.length ? (
              data.documents.map((d) => (
                <article className="team-record" key={d.id}>
                  <h3>{d.title}</h3>
                  <p>
                    {t(`kind.${d.kind}`)}
                    {d.expiresOn ? ` · ${date(d.expiresOn)}` : ""}
                  </p>
                  <a
                    className="secondary-button"
                    href={`/api/team/documents/${d.id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("download")}
                  </a>
                  {data.canArchiveDocument ? (
                    <details>
                      <summary>{t("archive")}</summary>
                      <TeamArchiveDocumentForm id={d.id} />
                    </details>
                  ) : null}
                </article>
              ))
            ) : (
              <EmptyState>{t("noDocuments")}</EmptyState>
            )}
          </>
        ) : (
          <p>{maskedValue}</p>
        )}
        {data.canUpload && data.documentMaxBytes && !data.profile.archived ? (
          <details>
            <summary>{t("upload")}</summary>
            <TeamDocumentForm personId={personId} maxBytes={data.documentMaxBytes} />
          </details>
        ) : null}
      </section>
      <section className="team-section">
        <h2>{t("wallet")}</h2>
        {data.canWallet ? (
          data.wallet ? (
            <>
              <p>{t("walletDerived")}</p>
              <ul>
                {data.wallet.balances.map((b) => (
                  <li className="money" key={b.currency}>
                    {formatCurrencyAmount(locale, b.amount, b.currency)}
                  </li>
                ))}
              </ul>
              {!data.wallet.balances.length ? <p>{t("noMovements")}</p> : null}
              <h3>{t("walletLedger")}</h3>
              <ul>
                {data.walletMovements.map((p) => (
                  <li key={p.id}>
                    {date(p.occurredAt)} · {p.reference} · {t(`side.${p.side}`)} ·{" "}
                    <span className="money">{formatCurrencyAmount(locale, p.amount, p.currency)}</span>
                  </li>
                ))}
              </ul>
              <nav className="app-actions" aria-label={t("pagination")}>
                {data.walletPage > 1 ? (
                  <Link href={`?from=${from}&until=${until}&walletPage=${data.walletPage - 1}`}>
                    {t("previous")}
                  </Link>
                ) : null}
                {data.walletNext ? (
                  <Link href={`?from=${from}&until=${until}&walletPage=${data.walletPage + 1}`}>
                    {t("next")}
                  </Link>
                ) : null}
              </nav>
            </>
          ) : (
            <EmptyState>{t("noWallet")}</EmptyState>
          )
        ) : (
          <p>{maskedValue}</p>
        )}
        {data.canLinkWallet &&
        (data.walletAccounts.length > 0 || data.canCreateWalletAccount) &&
        !data.wallet &&
        !data.profile.archived ? (
          <details>
            <summary>{t("linkWallet")}</summary>
            <TeamWalletForm
              personId={personId}
              accounts={data.walletAccounts}
              canCreate={data.canCreateWalletAccount}
              accountName={data.profile.displayName ?? ""}
            />
          </details>
        ) : null}
      </section>
      {data.canOffboard && !data.profile.archived ? (
        <section className="team-section">
          <h2>{t("offboarding")}</h2>
          <p>{t("offboardSafeguards")}</p>
          {data.offboarding ? (
            <p>
              {t("offboardChecks", { tasks: data.offboarding.openTasks })} ·{" "}
              {t(data.offboarding.walletClear ? "walletClear" : "walletNotClear")}
            </p>
          ) : null}
          <TeamOffboardForm personId={personId} />
        </section>
      ) : null}
    </AdminShell>
  );
}
