import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { z } from "zod";
import { EmptyState } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { calendarDateAt, formatDateTime } from "@/i18n/format";
import { financeKindSchema, monthStart, type financeAreas, type FinanceKind } from "@/modules/personal/domain/personal-finance";
import { personalNavigation, personalWorkspace } from "@/modules/personal/application/personal-session";
import { FinancePanel } from "@/modules/personal/ui/finance-panel";
import { MembersPanel } from "@/modules/personal/ui/members-panel";
import { DocumentsPanel } from "@/modules/personal/ui/documents-panel";
import { TransfersPanel } from "@/modules/personal/ui/transfers-panel";
import { ReportsPanel } from "@/modules/personal/ui/reports-panel";

const choices = {
  income: ["INCOME"], expenses: ["EXPENSE"], budgets: ["BUDGET"], savings: ["SAVINGS_GOAL", "SAVINGS_MOVEMENT"],
  investments: ["INVESTMENT"], positions: ["ASSET", "LIABILITY"]
} as const satisfies Partial<Record<(typeof financeAreas)[FinanceKind], readonly FinanceKind[]>>;

const paramsSchema = z.object({
  after: z.uuid().optional(), cursorDate: z.iso.date().optional(), series: z.uuid().optional(),
  kind: financeKindSchema.optional(), from: z.iso.date().optional(), through: z.iso.date().optional(),
  auditAt: z.iso.datetime().optional(), archived: z.literal("1").optional()
});

export default async function PersonalSection({ params, searchParams }: {
  params: Promise<{ locale: string; householdId: string; section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale: rawLocale, householdId, section } = await params;
  const locale = safeLocale(rawLocale);
  setRequestLocale(locale);
  const [t, navigation, search] = await Promise.all([
    getTranslations({ locale, namespace: "Personal" }), personalNavigation(locale, householdId), searchParams
  ]);
  if (!navigation.areas.some((area) => area === section)) notFound();
  const parsed = paramsSchema.safeParse(search);
  if (!parsed.success) notFound();
  const { after, cursorDate, series, kind, auditAt } = parsed.data;
  if (section === "transfers") return <TransfersPanel {...{ locale, householdId, after }} />;
  if (section === "documents") return <DocumentsPanel {...{ locale, householdId, after }} archived={parsed.data.archived === "1"} />;
  if (section === "members") return <MembersPanel {...{ locale, householdId, after }} />;
  if (section === "audit") {
    const audit = await personalWorkspace(locale, householdId, (scope) =>
      scope.auditTrail(after && auditAt ? { id: after, occurredAt: new Date(auditAt) } : undefined));
    return <section className="detail-panel">
      <h2>{t("sections.audit")}</h2>
      {audit.items.length ? <ul className="form-grid">
        {audit.items.map((event) => <li className="form-actions" key={event.id}>
          <strong>{t.has(`auditActions.${event.action.replace("personal.", "")}`)
            ? t(`auditActions.${event.action.replace("personal.", "")}` as "auditActions.finance_recorded") : t("privateEvent")}</strong>
          <time dateTime={event.occurredAt.toISOString()}>{formatDateTime(locale, event.occurredAt)}</time>
          <bdi>{event.actorId}</bdi>
        </li>)}
      </ul> : <EmptyState>{t("empty")}</EmptyState>}
      {audit.next ? <Link className="secondary-button" prefetch={false} href={`?after=${audit.next.id}&auditAt=${encodeURIComponent(audit.next.occurredAt.toISOString())}`}>{t("next")}</Link> : null}
    </section>;
  }

  const today = calendarDateAt(new Date(), "Africa/Casablanca");
  const from = parsed.data.from ?? monthStart(today);
  const through = parsed.data.through ?? today;
  if (from > through) return <p role="alert">{t("invalidDates")}</p>;
  if (section === "reports") return <ReportsPanel {...{ locale, householdId, from, through }} />;
  const available: readonly FinanceKind[] | undefined = choices[section as keyof typeof choices];
  if (!available) notFound();
  const active = kind ?? available[0];
  if (!available.includes(active)) notFound();

  return <>
    {available.length > 1 ? <nav className="form-actions" aria-label={t("recordTypes")}>
      {available.map((choice) => <Link key={choice} prefetch={false} className="secondary-button" href={`?kind=${choice}`} aria-current={active === choice ? "page" : undefined}>
        {t(`kinds.${choice}`)}
      </Link>)}
    </nav> : null}
    {section === "positions" ? <ReportsPanel {...{ locale, householdId, from, through }} mode="positions" /> : null}
    <FinancePanel {...{ locale, householdId, series }} kind={active} after={after && cursorDate ? { id: after, effectiveOn: cursorDate } : undefined} />
  </>;
}
