import { getTranslations, setRequestLocale } from "next-intl/server";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AdminShell, ShellHeader } from "@/design-system/shells";
import { configActorContextFromSession } from "@/modules/config/application/config-access";
import {
  ConfigAuthorizationError,
  ConfigValidationError,
  configEffectiveDateSchema,
  getConfigAdminModel
} from "@/modules/config/application/config-service";
import { ConfigHistoryFilter, ConfigRuleAdmin } from "@/modules/config/ui/config-rule-admin";
import { auth } from "@/platform/auth/session";
import { routing, type AppLocale } from "@/i18n/routing";

export const dynamic = "force-dynamic";

function safeLocale(locale: string): AppLocale {
  return routing.locales.includes(locale as AppLocale) ? (locale as AppLocale) : routing.defaultLocale;
}

function searchValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function searchDate(value: string | string[] | undefined): Date | undefined {
  const raw = searchValue(value);
  if (!raw) {
    return undefined;
  }

  const parsed = configEffectiveDateSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export default async function ConfigurationPage({
  params,
  searchParams
}: Readonly<{
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  const { locale } = await params;
  const query = await searchParams;
  const appLocale = safeLocale(locale);
  setRequestLocale(appLocale);

  const session = await auth();
  const ctx = await configActorContextFromSession(session);

  if (!ctx) {
    redirect(`/${appLocale}/login`);
  }

  const t = await getTranslations("Configuration");
  let model;
  let denied = false;

  try {
    model = await getConfigAdminModel(ctx, {
      previewKey: searchValue(query.key),
      previewScopeType: searchValue(query.scopeType),
      previewScopeId: searchValue(query.scopeId),
      previewAsOf: searchDate(query.asOf),
      ruleKey: searchValue(query.ruleKey), ruleScopeType: searchValue(query.ruleScopeType), ruleScopeId: searchValue(query.ruleScopeId),
      after: searchValue(query.after), before: searchValue(query.before)
    });
  } catch (error) {
    if (error instanceof ConfigValidationError) notFound();
    if (error instanceof ConfigAuthorizationError) {
      denied = true;
      model = {
        rules: [],
        properties: [],
        preview: null,
        catalogKeys: [],
        pagination: { next: null, previous: null }
      };
    } else {
      throw error;
    }
  }

  return (
    <AdminShell className="resource-page" testId="configuration-page">
      <ShellHeader
        actions={
          <Link className="secondary-button" href={`/${appLocale}/app`}>
            {t("backToWorkspace")}
          </Link>
        }
        eyebrow={t("eyebrow")}
        subtitle={t("subtitle")}
        title={t("title")}
      />

      {denied ? (
        <section className="workspace-main" data-testid="configuration-denied">
          <p className="panel-label">{t("denied.title")}</p>
          <p>{t("denied.subtitle")}</p>
        </section>
      ) : (
        <>
          <form className="audit-filter-form" method="get" data-testid="config-preview-form">
            <label className="field">
              <span>{t("form.key")}</span>
              <select name="key" defaultValue={searchValue(query.key) ?? model.catalogKeys[0] ?? ""}>
                {model.catalogKeys.map((key) => (
                  <option key={key} value={key}>
                    {key}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("form.scopeType")}</span>
              <select name="scopeType" defaultValue={searchValue(query.scopeType) ?? "organization"}>
                <option value="organization">{t("form.scopeOrganization")}</option>
                <option value="property">{t("form.scopeProperty")}</option>
              </select>
            </label>
            <label className="field">
              <span>{t("form.scopeId")}</span>
              <select name="scopeId" defaultValue={searchValue(query.scopeId) ?? ""}>
                <option value="">{t("form.scopeOrganization")}</option>
                {model.properties.map((property) => (
                  <option key={property.id} value={property.id}>
                    {property.name} - {property.city}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("form.asOf")}</span>
              <input name="asOf" type="datetime-local" defaultValue={searchValue(query.asOf) ?? ""} />
            </label>
            <button className="secondary-button" type="submit">
              {t("form.preview")}
            </button>
          </form>
          <ConfigHistoryFilter properties={model.properties} keys={model.catalogKeys}
            initial={{ key: searchValue(query.ruleKey) ?? "", scopeType: searchValue(query.ruleScopeType) ?? "", scopeId: searchValue(query.ruleScopeId) ?? "" }}
            labels={{ key: t("form.key"), scope: t("form.scopeType"), property: t("form.scopeProperty"), organization: t("form.scopeOrganization"),
              allScopes: t("browse.allScopes"), allProperties: t("browse.allProperties"), find: t("browse.find") }} />
          <nav className="actions" aria-label={t("browse.navigation")} data-testid="config-history-pages">
            {([['previous', 'before'], ['next', 'after']] as const).map(([label, direction]) => {
              const cursor = model.pagination[label]; if (!cursor) return null;
              const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) { const text = searchValue(value); if (text && key !== 'after' && key !== 'before') params.set(key, text); }
              params.set(direction, cursor); return <Link key={label} className="secondary-button" data-testid={`config-history-${label}`} href={`/${appLocale}/app/configuration?${params}`}>{t(`browse.${label}`)}</Link>;
            })}
          </nav>
          <ConfigRuleAdmin
            locale={appLocale}
            model={model}
            labels={{
              createTitle: t("createTitle"),
              historyTitle: t("historyTitle"),
              previewTitle: t("previewTitle"),
              key: t("form.key"),
              customFeatureFlagKey: t("form.customFeatureFlagKey"),
              scopeType: t("form.scopeType"),
              scopeOrganization: t("form.scopeOrganization"),
              scopeProperty: t("form.scopeProperty"),
              scopeId: t("form.scopeId"),
              noProperties: t("form.noProperties"),
              lifecycle: t("form.lifecycle"),
              draft: t("lifecycle.DRAFT"),
              active: t("lifecycle.ACTIVE"),
              retired: t("lifecycle.RETIRED"),
              value: t("form.value"),
              valuePlaceholder: t("form.valuePlaceholder"),
              effectiveFrom: t("form.effectiveFrom"),
              effectiveTo: t("form.effectiveTo"),
              reason: t("form.reason"),
              createVersion: t("form.createVersion"),
              saving: t("form.saving"),
              activate: t("form.activate"),
              retire: t("form.retire"),
              empty: t("empty"),
              noDiff: t("diff.none"),
              changed: t("diff.changed"),
              asOf: t("form.asOf"),
              resolvedRule: t("preview.resolved"),
              noResolvedRule: t("preview.none"),
              version: t("columns.version"),
              scope: t("columns.scope"),
              status: t("columns.status"),
              dates: t("columns.dates"),
              diff: t("columns.diff"),
              valuePreview: t("columns.value"),
              messages: {
                created: t("messages.created"),
                activated: t("messages.activated"),
                retired: t("messages.retired"),
                validation: t("messages.validation"),
                unauthorized: t("messages.unauthorized"),
                forbidden: t("messages.forbidden"),
                notFound: t("messages.notFound"),
                generic: t("messages.generic")
              }
            }}
          />
        </>
      )}
    </AdminShell>
  );
}
