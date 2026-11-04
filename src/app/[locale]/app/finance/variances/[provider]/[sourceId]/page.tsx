import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { safeLocale } from "@/i18n/routing";
import { requireCompensationSession } from "@/modules/finance/ui/compensation-access";
import { varianceSourceReferenceSchema } from "@/modules/finance/domain/variance-workflow";
import { VarianceWorkspace } from "@/modules/finance/ui/variance-workspace";
export const dynamic = "force-dynamic";
export default async function Page({ params }: { params: Promise<{ locale: string; provider: string; sourceId: string }> }) {
  const values = await params, locale = safeLocale(values.locale); setRequestLocale(locale);
  const actor = await requireCompensationSession(locale), source = varianceSourceReferenceSchema.safeParse({ provider: values.provider, id: values.sourceId });
  if (!source.success) notFound();
  const t = await getTranslations("VarianceCenter"), scope = [actor.organizationId, actor.actorId, source.data.provider, source.data.id].join(".");
  return <AdminShell className="resource-page compensation-page variance-center-page" testId="variance-workflow-page"><ShellHeader eyebrow={t("eyebrow")} title={t("title")} subtitle={t("guidance")} actions={<Link className="secondary-button" prefetch={false} href={`/${locale}/app/finance/variances`}>{t("browse")}</Link>}/>
    <VarianceWorkspace key={scope} locale={locale} scope={scope} actorId={actor.actorId} source={source.data}/></AdminShell>;
}
